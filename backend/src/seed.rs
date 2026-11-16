//! Dev seeding: `webgame-server seed <bundle.zip>...` or `webgame-server seed --dir <folder>`.

use std::path::{Path, PathBuf};

use crate::AppState;
use crate::error::AppError;
use crate::routes::auth::create_user;
use crate::routes::games::{NewGame, create_game_record};

pub const DEMO_USERNAME: &str = "demo";
pub const DEMO_EMAIL: &str = "demo@example.com";
pub const DEMO_PASSWORD: &str = "demo12345";

/// Expand args into a list of zip paths (`--dir X` / `--seed-dir X` adds every *.zip in X).
pub fn collect_zips(args: &[String]) -> anyhow::Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        if arg == "--dir" || arg == "--seed-dir" {
            let dir = it
                .next()
                .ok_or_else(|| anyhow::anyhow!("{arg} needs a directory"))?;
            let mut found: Vec<PathBuf> = std::fs::read_dir(dir)?
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("zip")))
                .collect();
            found.sort();
            out.extend(found);
        } else {
            out.push(PathBuf::from(arg));
        }
    }
    Ok(out)
}

async fn demo_user_id(state: &AppState) -> anyhow::Result<String> {
    let existing: Option<(String,)> =
        sqlx::query_as("SELECT id FROM users WHERE username_lower = ?")
            .bind(DEMO_USERNAME)
            .fetch_optional(&state.db)
            .await?;
    if let Some((id,)) = existing {
        return Ok(id);
    }
    create_user(state, DEMO_USERNAME, DEMO_EMAIL, DEMO_PASSWORD)
        .await
        .map_err(|e| anyhow::anyhow!("creating demo user: {e}"))
}

fn title_from_path(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().replace(['-', '_'], " "))
        .unwrap_or_else(|| "Untitled".into())
        .chars()
        .take(80)
        .collect()
}

pub async fn run(state: &AppState, zips: &[PathBuf]) -> anyhow::Result<()> {
    let owner = demo_user_id(state).await?;
    println!("demo user: {DEMO_USERNAME} / {DEMO_PASSWORD}");
    for zip in zips {
        let bytes =
            std::fs::read(zip).map_err(|e| anyhow::anyhow!("reading {}: {e}", zip.display()))?;
        // Prefer game.json's name; fall back to the file name.
        let title = match crate::bundle::validate(&bytes) {
            Ok(meta) => meta.name.unwrap_or_else(|| title_from_path(zip)),
            Err(e) => {
                eprintln!("skipping {}: {e}", zip.display());
                continue;
            }
        };
        let new = NewGame {
            title: Some(title.chars().take(80).collect()),
            description: format!(
                "Seeded from {}",
                zip.file_name().unwrap_or_default().to_string_lossy()
            ),
            tags: vec!["demo".into()],
            published: true,
            notes: String::new(),
        };
        match create_game_record(state, &owner, new, bytes, None).await {
            Ok(id) => println!("seeded {} -> /play/{id}", zip.display()),
            Err(AppError::Validation(m)) => eprintln!("skipping {}: {m}", zip.display()),
            Err(e) => return Err(anyhow::anyhow!("seeding {}: {e}", zip.display())),
        }
    }
    seed_collection(state, &owner).await?;
    Ok(())
}

/// F008: the demo collection's title, description and games (example title, note), in order.
pub const DEMO_COLLECTION_TITLE: &str = "Arcade starter pack";
pub const DEMO_COLLECTION_DESCRIPTION: &str = "Four short games to try first.";
pub const DEMO_COLLECTION_GAMES: &[(&str, &str)] = &[
    ("Space Dodge", "A two-minute warm-up: dodge, shoot, repeat."),
    ("Brick Breaker", "Six levels of classic paddle action."),
    (
        "Pixel Peaks",
        "A short platformer climb with three achievements.",
    ),
    (
        "Ember Garden",
        "Light lanterns and catch moths at your own pace.",
    ),
];

/// F008: one public collection of the demo user's example games. Idempotent: skipped when the
/// demo user already has a collection with this title, or owns none of the example games.
/// Returns the new collection's id.
pub async fn seed_collection(state: &AppState, owner: &str) -> anyhow::Result<Option<String>> {
    let exists: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM collections WHERE owner_id = ? AND title = ?")
            .bind(owner)
            .bind(DEMO_COLLECTION_TITLE)
            .fetch_optional(&state.db)
            .await?;
    if exists.is_some() {
        return Ok(None);
    }
    let mut games: Vec<(String, &str)> = Vec::new();
    for (title, note) in DEMO_COLLECTION_GAMES {
        // The newest copy when the example was seeded more than once.
        let id: Option<String> = sqlx::query_scalar(
            "SELECT id FROM games WHERE owner_id = ? AND title = ?              ORDER BY created_at DESC, rowid DESC LIMIT 1",
        )
        .bind(owner)
        .bind(title)
        .fetch_optional(&state.db)
        .await?;
        if let Some(id) = id {
            games.push((id, note));
        }
    }
    if games.is_empty() {
        return Ok(None);
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = crate::models::now_rfc3339();
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO collections (id, owner_id, title, description, visibility, created_at,          updated_at) VALUES (?, ?, ?, ?, 'public', ?, ?)",
    )
    .bind(&id)
    .bind(owner)
    .bind(DEMO_COLLECTION_TITLE)
    .bind(DEMO_COLLECTION_DESCRIPTION)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    for (pos, (gid, note)) in games.iter().enumerate() {
        sqlx::query(
            "INSERT INTO collection_games (collection_id, game_id, position, note, added_at)              VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(gid)
        .bind(pos as i64)
        .bind(note)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    println!("seeded collection \"{DEMO_COLLECTION_TITLE}\" -> /c/{id}");
    Ok(Some(id))
}
