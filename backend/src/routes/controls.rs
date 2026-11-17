//! F016: synced control bindings, one row per user per game (docs/API.md § F016 additions,
//! docs/ARCHITECTURE.md § F016 additions). Visibility follows the cloud-save rule.
//!
//! Validation and normalisation reuse the F009 tables and rules in `bundle.rs`; there is no
//! copy of them here.

use std::collections::BTreeMap;

use axum::Json;
use axum::extract::State;
use serde::Serialize;
use serde::ser::SerializeMap;
use serde_json::{Map, Value};

use crate::AppState;
use crate::auth::AuthUser;
use crate::bundle::{
    ACTION_ID_MAX, BINDABLE_KEYS, GAMEPAD_BUTTONS, MAX_ACTION_GAMEPAD, MAX_ACTION_KEYS,
    MAX_ACTIONS, parse_binding_list, quoted, valid_action_id,
};
use crate::error::{AppError, AppResult};
use crate::extract::{ApiJson, ApiPath};
use crate::models::{ControlAction, now_rfc3339};
use crate::ratelimit::Limit;
use crate::routes::games::{fetch_visible_game, limit_user};

/// Validated (not yet normalised) bindings: action id → codes / button names.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RawBindings {
    pub keys: BTreeMap<String, Vec<String>>,
    pub gamepad: BTreeMap<String, Vec<String>>,
}

/// Normalised `ControlBindings` (API § F016): entries in manifest order. Serialises as
/// `{"keys":{…},"gamepad":{…}}` keeping that order.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ControlBindings {
    pub keys: Vec<(String, Vec<String>)>,
    pub gamepad: Vec<(String, Vec<String>)>,
}

struct OrderedMap<'a>(&'a [(String, Vec<String>)]);

impl Serialize for OrderedMap<'_> {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(self.0.len()))?;
        for (id, list) in self.0 {
            m.serialize_entry(id, list)?;
        }
        m.end()
    }
}

impl Serialize for ControlBindings {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(2))?;
        m.serialize_entry("keys", &OrderedMap(&self.keys))?;
        m.serialize_entry("gamepad", &OrderedMap(&self.gamepad))?;
        m.end()
    }
}

/// `ControlBindingsResponse` (`GET`) and the `PUT` response (both fields set).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlBindingsResponse {
    pub bindings: Option<ControlBindings>,
    pub updated_at: Option<String>,
}

/// One `keys` / `gamepad` object of `bindings` (strict). Absent or `null` → empty.
fn validate_section(
    bindings: &Map<String, Value>,
    field: &str,
    max: usize,
    table: &[&str],
) -> Result<BTreeMap<String, Vec<String>>, AppError> {
    let at = format!("bindings.{field}");
    let obj = match bindings.get(field) {
        None | Some(Value::Null) => return Ok(BTreeMap::new()),
        Some(Value::Object(o)) => o,
        Some(_) => return Err(AppError::validation(format!("{at} must be an object"))),
    };
    if obj.len() > MAX_ACTIONS {
        return Err(AppError::validation(format!(
            "{at} must have at most {MAX_ACTIONS} actions"
        )));
    }
    let mut out = BTreeMap::new();
    for (id, value) in obj {
        if !valid_action_id(id) {
            return Err(AppError::validation(format!(
                "{at} {} is not a valid action id (^[a-z0-9_-]{{1,{ACTION_ID_MAX}}}$)",
                quoted(id)
            )));
        }
        // `parse_binding_list` treats `null` as `[]` (game.json rule); here a value must be
        // an array.
        if !value.is_array() {
            return Err(AppError::validation(format!("{at}.{id} must be an array")));
        }
        let list = parse_binding_list(obj, &at, id, max, table, "can't be bound")?;
        out.insert(id.clone(), list);
    }
    Ok(out)
}

/// Strict validation of the `bindings` value (API § F016 "Validation"). The first violation
/// is a 422 `validation` naming the path. Unknown fields besides `keys`/`gamepad` are ignored.
pub fn validate_bindings(bindings: Option<&Value>) -> Result<RawBindings, AppError> {
    let obj = match bindings {
        Some(Value::Object(o)) => o,
        _ => return Err(AppError::validation("bindings must be a JSON object")),
    };
    Ok(RawBindings {
        keys: validate_section(obj, "keys", MAX_ACTION_KEYS, BINDABLE_KEYS)?,
        gamepad: validate_section(obj, "gamepad", MAX_ACTION_GAMEPAD, GAMEPAD_BUTTONS)?,
    })
}

fn dedup(list: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(list.len());
    for s in list {
        if !out.contains(s) {
            out.push(s.clone());
        }
    }
    out
}

/// API § F016 "Normalisation": keep only ids declared by `actions` (the game's current
/// version), de-duplicate in order, drop entries equal to the action's defaults (same order),
/// list entries in manifest order.
pub fn normalize_bindings(bindings: &RawBindings, actions: &[ControlAction]) -> ControlBindings {
    let mut out = ControlBindings::default();
    for a in actions {
        if let Some(list) = bindings.keys.get(&a.id) {
            let list = dedup(list);
            if list != a.keys {
                out.keys.push((a.id.clone(), list));
            }
        }
        if let Some(list) = bindings.gamepad.get(&a.id) {
            let list = dedup(list);
            if list != a.gamepad {
                out.gamepad.push((a.id.clone(), list));
            }
        }
    }
    out
}

pub async fn get_controls(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
) -> AppResult<Json<ControlBindingsResponse>> {
    let game = fetch_visible_game(&state, &id, Some(&user.id)).await?;
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT bindings, updated_at FROM control_bindings WHERE user_id = ? AND game_id = ?",
    )
    .bind(&user.id)
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    let stored = row.and_then(|(raw, updated_at)| {
        let parsed = serde_json::from_str::<Value>(&raw)
            .map_err(|e| e.to_string())
            .and_then(|v| validate_bindings(Some(&v)).map_err(|e| e.to_string()));
        match parsed {
            Ok(b) => Some((b, updated_at)),
            Err(error) => {
                tracing::warn!(game_id = %id, %error, "unparsable control_bindings row; ignored");
                None
            }
        }
    });
    Ok(Json(match stored {
        Some((raw, updated_at)) => ControlBindingsResponse {
            bindings: Some(normalize_bindings(&raw, &game.actions())),
            updated_at: Some(updated_at),
        },
        None => ControlBindingsResponse {
            bindings: None,
            updated_at: None,
        },
    }))
}

pub async fn put_controls(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
    ApiJson(body): ApiJson<Value>,
) -> AppResult<Json<ControlBindingsResponse>> {
    let game = fetch_visible_game(&state, &id, Some(&user.id)).await?;
    limit_user(&state, Limit::Controls, &user.id)?;
    let raw = validate_bindings(body.get("bindings"))?;
    let bindings = normalize_bindings(&raw, &game.actions());
    let serialized =
        serde_json::to_string(&bindings).map_err(|e| AppError::Internal(format!("json: {e}")))?;
    let now = now_rfc3339();
    sqlx::query(
        "INSERT INTO control_bindings (user_id, game_id, bindings, updated_at) \
         VALUES (?, ?, ?, ?) \
         ON CONFLICT (user_id, game_id) DO UPDATE SET bindings = excluded.bindings, \
         updated_at = excluded.updated_at",
    )
    .bind(&user.id)
    .bind(&id)
    .bind(&serialized)
    .bind(&now)
    .execute(&state.db)
    .await?;
    Ok(Json(ControlBindingsResponse {
        bindings: Some(bindings),
        updated_at: Some(now),
    }))
}
