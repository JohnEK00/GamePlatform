//! F007 in-app notifications (API.md § F007, ARCHITECTURE.md § F007).
//!
//! Write path: fan-out on write, one `notifications` row per (recipient, kind, group) while
//! unread, with one `notification_events` row per contributing action. Like `activity.rs`,
//! every writer is best effort: it runs after the triggering write succeeded, inside a nested
//! transaction (a SAVEPOINT when the caller already is in one), logs failures with
//! `tracing::warn!` and never fails the request.
//!
//! Read path: the page / count / mark-read queries and the batched lookups used by
//! `routes/notifications.rs`.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde::Serialize;
use sqlx::{Connection, Row, SqliteConnection, SqlitePool};

use crate::models::{UserRef, thumbnail_url, user_ref_from_row};

/// Notification kinds. The API strings come from [`Kind::as_str`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    Comment,
    Reply,
    Heart,
    Follow,
    GamePublished,
}

impl Kind {
    pub const ALL: [Kind; 5] = [
        Kind::Comment,
        Kind::Reply,
        Kind::Heart,
        Kind::Follow,
        Kind::GamePublished,
    ];

    /// The `NotificationKind` string (also the stored `kind` column).
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Comment => "comment",
            Kind::Reply => "reply",
            Kind::Heart => "heart",
            Kind::Follow => "follow",
            Kind::GamePublished => "gamePublished",
        }
    }

    /// The `notification_settings` column that mutes this kind (a fixed match; never built
    /// from input, so it is safe to splice into SQL).
    pub fn setting_column(self) -> &'static str {
        match self {
            Kind::Comment => "comments",
            Kind::Reply => "replies",
            Kind::Heart => "hearts",
            Kind::Follow => "follows",
            Kind::GamePublished => "new_games",
        }
    }

    pub fn parse(s: &str) -> Option<Kind> {
        Kind::ALL.into_iter().find(|k| k.as_str() == s)
    }
}

/// Group keys (built here, never from input).
pub fn game_group(game_id: &str) -> String {
    format!("game:{game_id}")
}

pub fn thread_group(root_id: &str) -> String {
    format!("thread:{root_id}")
}

pub fn comment_group(comment_id: &str) -> String {
    format!("comment:{comment_id}")
}

pub const FOLLOW_GROUP: &str = "follow";

/// Recipients per `gamePublished` fan-out transaction.
pub const FAN_OUT_CHUNK: usize = 500;
/// Excerpt length in Unicode scalar values.
pub const EXCERPT_CHARS: i64 = 140;
/// The unread count is capped here (clients show "99+").
pub const UNREAD_CAP: i64 = 100;
/// Retention (API § F007).
pub const READ_RETENTION_DAYS: i64 = 30;
pub const MAX_AGE_DAYS: i64 = 90;
pub const PER_RECIPIENT_CAP: i64 = 200;

/// RFC3339 with milliseconds and `Z`: the format of every stored timestamp.
pub fn stamp(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// One notification event to record.
#[derive(Debug, Clone)]
pub struct NewNotification {
    pub recipient_id: String,
    pub kind: Kind,
    pub group_key: String,
    pub game_id: Option<String>,
    /// `heart`: the hearted comment; `reply`: the thread root; else `None`.
    pub comment_id: Option<String>,
    pub actor_id: String,
    /// `comment`/`reply`: the newly posted comment; else `None`.
    pub event_comment_id: Option<String>,
    /// Hearts, follows: skip when this actor already has an event in any notification of
    /// (recipient, kind, group), read or unread; a retracted one is restored instead (L1).
    pub dedupe_actor: bool,
    pub now: DateTime<Utc>,
}

/// Record one event for one recipient (best effort; failures are logged). `conn` must not be
/// inside a transaction: the write runs in its own `BEGIN IMMEDIATE` transaction (M1).
pub async fn notify(conn: &mut SqliteConnection, n: &NewNotification) {
    if n.recipient_id == n.actor_id {
        return;
    }
    if let Err(e) = try_notify(conn, n).await {
        tracing::warn!(kind = n.kind.as_str(), error = %e, "failed to record notification");
    }
}

/// [`notify`] on a fresh pooled connection.
pub async fn notify_pool(pool: &SqlitePool, n: &NewNotification) {
    if n.recipient_id == n.actor_id {
        return;
    }
    if let Some(mut conn) = crate::activity::acquire(pool).await {
        notify(&mut conn, n).await;
    }
}

/// M1: `BEGIN IMMEDIATE` takes the write lock up front (waiting under `busy_timeout`), so no
/// read snapshot can go stale before the first write; the dedupe check lives inside the
/// upsert itself.
async fn try_notify(conn: &mut SqliteConnection, n: &NewNotification) -> sqlx::Result<()> {
    let kind = n.kind.as_str();
    let now = stamp(n.now);
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    // `{col}` is a fixed column name from `Kind::setting_column`.
    let col = n.kind.setting_column();
    if n.dedupe_actor {
        // L1: the actor re-joins a group they were retracted from: restore the event and keep
        // `updated_at`, so the item neither moves nor counts as new activity. Review 5 L5: not
        // when the recipient has muted the kind since (the insert below is muted too).
        let restored = sqlx::query(&format!(
            "UPDATE notification_events SET retracted_at = NULL \
             WHERE actor_id = ?4 AND retracted_at IS NOT NULL AND notification_id IN \
             (SELECT id FROM notifications WHERE recipient_id = ?1 AND kind = ?2 \
              AND group_key = ?3) \
             AND NOT EXISTS (SELECT 1 FROM notification_settings s WHERE s.user_id = ?1 \
               AND s.{col} = 0)"
        ))
        .bind(&n.recipient_id)
        .bind(kind)
        .bind(&n.group_key)
        .bind(&n.actor_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if restored > 0 {
            return tx.commit().await;
        }
    }
    let id: Option<i64> = sqlx::query_scalar(&format!(
        "INSERT INTO notifications (recipient_id, kind, group_key, game_id, comment_id, \
         created_at, updated_at) \
         SELECT ?1, ?2, ?3, ?5, ?6, ?7, ?7 \
         WHERE NOT EXISTS (SELECT 1 FROM notification_settings s WHERE s.user_id = ?1 \
           AND s.{col} = 0) \
         AND (?8 = 0 OR NOT EXISTS (SELECT 1 FROM notifications d \
           JOIN notification_events e ON e.notification_id = d.id \
           WHERE d.recipient_id = ?1 AND d.kind = ?2 AND d.group_key = ?3 \
           AND e.actor_id = ?4)) \
         ON CONFLICT (recipient_id, kind, group_key) WHERE read_at IS NULL \
         DO UPDATE SET updated_at = excluded.updated_at \
         RETURNING id"
    ))
    .bind(&n.recipient_id)
    .bind(kind)
    .bind(&n.group_key)
    .bind(&n.actor_id)
    .bind(&n.game_id)
    .bind(&n.comment_id)
    .bind(&now)
    .bind(i64::from(n.dedupe_actor))
    .fetch_optional(&mut *tx)
    .await?;
    let Some(id) = id else {
        // Muted by the recipient's settings, or already seen (dedupe).
        return tx.commit().await;
    };
    sqlx::query(
        "INSERT OR IGNORE INTO notification_events (notification_id, actor_id, comment_id, \
         created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(id)
    .bind(&n.actor_id)
    .bind(&n.event_comment_id)
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    tx.commit().await
}

/// Retract `actor_id`'s events from the recipient's **unread** notification of the group
/// (un-heart, unfollow). L1: the event is tombstoned (`retracted_at`), not deleted, so a
/// re-heart / re-follow restores it without re-notifying. Best effort.
pub async fn retract(
    conn: &mut SqliteConnection,
    recipient_id: &str,
    kind: Kind,
    group_key: &str,
    actor_id: &str,
) {
    let res = sqlx::query(
        "UPDATE notification_events SET retracted_at = ?5 \
         WHERE actor_id = ?4 AND retracted_at IS NULL AND notification_id IN \
         (SELECT id FROM notifications WHERE recipient_id = ?1 AND kind = ?2 \
          AND group_key = ?3 AND read_at IS NULL)",
    )
    .bind(recipient_id)
    .bind(kind.as_str())
    .bind(group_key)
    .bind(actor_id)
    .bind(stamp(Utc::now()))
    .execute(&mut *conn)
    .await;
    if let Err(e) = res {
        tracing::warn!(kind = kind.as_str(), error = %e, "failed to retract notification");
    }
}

/// [`retract`] on a fresh pooled connection.
pub async fn retract_pool(
    pool: &SqlitePool,
    recipient_id: &str,
    kind: Kind,
    group_key: &str,
    actor_id: &str,
) {
    if let Some(mut conn) = crate::activity::acquire(pool).await {
        retract(&mut conn, recipient_id, kind, group_key, actor_id).await;
    }
}

// ---------------------------------------------------------------------------
// gamePublished fan-out (L2: background, resumable)
// ---------------------------------------------------------------------------

/// A chunk is retried this many times in a row before the fan-out is parked until the next
/// startup ([`resume_fan_outs`]) or the next un-park ([`FAN_OUT_UNPARK_EVERY`]).
pub const FAN_OUT_MAX_ATTEMPTS: i64 = 5;
const FAN_OUT_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(50);

/// Queue the `gamePublished` fan-out of a first publish. Call inside the publishing
/// transaction (so the entry commits with `first_published_at`), then [`FanOut::kick`] after
/// the commit.
pub async fn queue_game_published(
    conn: &mut SqliteConnection,
    game_id: &str,
    owner_id: &str,
    now: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO notification_fanouts (game_id, owner_id, created_at) VALUES (?, ?, ?) \
         ON CONFLICT (game_id) DO NOTHING",
    )
    .bind(game_id)
    .bind(owner_id)
    .bind(now)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

type Tasks = std::sync::Arc<std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>>;

/// Runs queued fan-outs off the request path, one worker at a time. Tests await
/// [`FanOut::idle`] instead of polling.
#[derive(Clone, Default)]
pub struct FanOut {
    tasks: Tasks,
    worker: std::sync::Arc<tokio::sync::Mutex<()>>,
}

impl FanOut {
    /// Spawn a worker that drains every pending fan-out (a no-op when none is queued).
    pub fn kick(&self, db: &SqlitePool) {
        let db = db.clone();
        let worker = self.worker.clone();
        let handle = tokio::spawn(async move {
            let _guard = worker.lock().await;
            drain_fan_outs(&db).await;
        });
        let mut tasks = self.tasks.lock().unwrap_or_else(|e| e.into_inner());
        tasks.retain(|t| !t.is_finished());
        tasks.push(handle);
    }

    /// Resolves once every worker spawned so far has finished.
    pub async fn idle(&self) {
        loop {
            let tasks = {
                let mut guard = self.tasks.lock().unwrap_or_else(|e| e.into_inner());
                std::mem::take(&mut *guard)
            };
            if tasks.is_empty() {
                return;
            }
            for t in tasks {
                let _ = t.await;
            }
        }
    }
}

/// Startup: un-park fan-outs that ran out of attempts and resume every pending one.
pub async fn resume_fan_outs(db: &SqlitePool, fan_out: &FanOut) {
    if let Err(e) = sqlx::query("UPDATE notification_fanouts SET attempts = 0 WHERE attempts > 0")
        .execute(db)
        .await
    {
        tracing::warn!(error = %e, "failed to reset notification fan-out attempts");
    }
    fan_out.kick(db);
}

/// Review 5 L9: a parked fan-out is retried at most this often (by the housekeeping loop,
/// [`crate::trending::Housekeeping`]), so a long-running server doesn't strand it until the
/// next restart.
pub const FAN_OUT_UNPARK_EVERY: std::time::Duration = std::time::Duration::from_secs(600);

/// Give parked fan-outs (out of attempts) a fresh set of attempts. Returns the rows un-parked.
pub async fn unpark_fan_outs(db: &SqlitePool) -> u64 {
    match sqlx::query("UPDATE notification_fanouts SET attempts = 0 WHERE attempts >= ?")
        .bind(FAN_OUT_MAX_ATTEMPTS)
        .execute(db)
        .await
    {
        Ok(r) => r.rows_affected(),
        Err(e) => {
            tracing::warn!(error = %e, "failed to un-park notification fan-outs");
            0
        }
    }
}

/// Process queued fan-outs chunk by chunk until none is left (or every remaining one is
/// parked). Returns the number of chunks committed.
pub async fn drain_fan_outs(db: &SqlitePool) -> u64 {
    let mut chunks = 0;
    loop {
        let next: Option<(String, i64)> = match sqlx::query_as(
            "SELECT game_id, attempts FROM notification_fanouts WHERE attempts < ? \
             ORDER BY created_at, game_id LIMIT 1",
        )
        .bind(FAN_OUT_MAX_ATTEMPTS)
        .fetch_optional(db)
        .await
        {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "failed to read pending notification fan-outs");
                return chunks;
            }
        };
        let Some((game_id, attempts)) = next else {
            return chunks;
        };
        match fan_out_chunk(db, &game_id, Utc::now()).await {
            Ok(()) => chunks += 1,
            Err(e) => {
                tracing::warn!(game_id, error = %e, "gamePublished fan-out chunk failed");
                let bumped = sqlx::query(
                    "UPDATE notification_fanouts SET attempts = attempts + 1 WHERE game_id = ?",
                )
                .bind(&game_id)
                .execute(db)
                .await;
                if bumped.is_err() {
                    // Progress can't be recorded either; leave the rest to the next kick.
                    return chunks;
                }
                if attempts + 1 < FAN_OUT_MAX_ATTEMPTS {
                    let factor = u32::try_from(attempts + 1).unwrap_or(1);
                    tokio::time::sleep(FAN_OUT_RETRY_DELAY * factor).await;
                }
            }
        }
    }
}

/// One chunk of at most [`FAN_OUT_CHUNK`] followers of one queued game, in one
/// `BEGIN IMMEDIATE` transaction that also advances (or removes) the cursor.
async fn fan_out_chunk(db: &SqlitePool, game_id: &str, now: DateTime<Utc>) -> sqlx::Result<()> {
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
    let row: Option<(String, String, String)> = sqlx::query_as(
        "SELECT owner_id, after_follower, created_at FROM notification_fanouts \
         WHERE game_id = ?",
    )
    .bind(game_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((owner_id, after, published_at)) = row else {
        // Finished meanwhile, or the game was deleted.
        return tx.commit().await;
    };
    let followers: Vec<String> = sqlx::query_scalar(
        "SELECT follower_id FROM follows WHERE followee_id = ?1 AND follower_id > ?2 \
         AND created_at <= ?3 ORDER BY follower_id LIMIT ?4",
    )
    .bind(&owner_id)
    .bind(&after)
    .bind(&published_at)
    .bind(FAN_OUT_CHUNK as i64)
    .fetch_all(&mut *tx)
    .await?;
    if !followers.is_empty() {
        let recipients = serde_json::to_string(&followers).unwrap_or_else(|_| "[]".into());
        let group = game_group(game_id);
        let now = stamp(now);
        // Exactly once per (recipient, game): the cursor commits with the chunk, so no dedupe.
        sqlx::query(
            "INSERT INTO notifications (recipient_id, kind, group_key, game_id, comment_id, \
             created_at, updated_at) \
             SELECT r.value, 'gamePublished', ?2, ?3, NULL, ?4, ?4 FROM json_each(?1) r \
             WHERE r.value <> ?5 AND NOT EXISTS (SELECT 1 FROM notification_settings s \
               WHERE s.user_id = r.value AND s.new_games = 0) \
             ON CONFLICT (recipient_id, kind, group_key) WHERE read_at IS NULL \
             DO UPDATE SET updated_at = excluded.updated_at",
        )
        .bind(&recipients)
        .bind(&group)
        .bind(game_id)
        .bind(&now)
        .bind(&owner_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT OR IGNORE INTO notification_events (notification_id, actor_id, comment_id, \
             created_at) \
             SELECT n.id, ?3, NULL, ?4 FROM notifications n \
             WHERE n.recipient_id IN (SELECT value FROM json_each(?1)) \
             AND n.kind = 'gamePublished' AND n.group_key = ?2 AND n.read_at IS NULL",
        )
        .bind(&recipients)
        .bind(&group)
        .bind(&owner_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }
    if followers.len() < FAN_OUT_CHUNK {
        sqlx::query("DELETE FROM notification_fanouts WHERE game_id = ?")
            .bind(game_id)
            .execute(&mut *tx)
            .await?;
    } else if let Some(last) = followers.last() {
        sqlx::query(
            "UPDATE notification_fanouts SET after_follower = ?, attempts = 0 WHERE game_id = ?",
        )
        .bind(last)
        .bind(game_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

// ---------------------------------------------------------------------------
// Retention (L3: lock-friendly)
// ---------------------------------------------------------------------------

/// A notification `n` with at least one live (not retracted) event, i.e. one that is listed.
const LIVE: &str = "EXISTS (SELECT 1 FROM notification_events e \
     WHERE e.notification_id = n.id AND e.retracted_at IS NULL)";

/// Ids per short delete statement.
pub const PRUNE_BATCH: usize = 500;

/// Delete `ids` that still satisfy `cond` (which may use `?2` and `?3`) in one short
/// autocommit statement.
async fn delete_ids(
    pool: &SqlitePool,
    ids: &[i64],
    cond: &str,
    b2: &str,
    b3: Option<i64>,
) -> sqlx::Result<u64> {
    let json = serde_json::to_string(ids).unwrap_or_else(|_| "[]".into());
    Ok(sqlx::query(&format!(
        "DELETE FROM notifications WHERE id IN (SELECT value FROM json_each(?1)) AND ({cond})"
    ))
    .bind(json)
    .bind(b2)
    .bind(b3)
    .execute(pool)
    .await?
    .rows_affected())
}

/// Retention (API § F007): read > 30 days, any > 90 days, and beyond the newest 200 per
/// recipient. Notifications without events are removed by the `0014` trigger when their last
/// event goes. L3: candidate ids are read first (no write lock), then deleted in batches of
/// [`PRUNE_BATCH`] in short transactions that re-check the rule. Returns the rows deleted.
pub async fn prune(pool: &SqlitePool, now: DateTime<Utc>) -> sqlx::Result<u64> {
    let read_cutoff = stamp(now - Duration::days(READ_RETENTION_DAYS));
    let age_cutoff = stamp(now - Duration::days(MAX_AGE_DAYS));
    let mut total = 0;
    let rules: [(&str, &str, &str); 2] = [
        (
            "SELECT id FROM notifications WHERE read_at IS NOT NULL AND read_at < ?1 LIMIT ?2",
            "read_at IS NOT NULL AND read_at < ?2",
            &read_cutoff,
        ),
        (
            "SELECT id FROM notifications WHERE updated_at < ?1 LIMIT ?2",
            "updated_at < ?2",
            &age_cutoff,
        ),
    ];
    for (select, cond, cutoff) in rules {
        loop {
            let ids: Vec<i64> = sqlx::query_scalar(select)
                .bind(cutoff)
                .bind(PRUNE_BATCH as i64)
                .fetch_all(pool)
                .await?;
            if ids.is_empty() {
                break;
            }
            let n = delete_ids(pool, &ids, cond, cutoff, None).await?;
            total += n;
            if ids.len() < PRUNE_BATCH || n == 0 {
                break;
            }
            tokio::task::yield_now().await;
        }
    }

    // Per-recipient cap: only recipients above it, each read via
    // idx_notifications_recipient_updated. Review 5 L5: only visible rows (with a live event)
    // count and are ranked; tombstone-only rows (fully retracted toggles) are invisible, so
    // they never push real notifications out. They age out under the 90-day rule.
    let over: Vec<String> = sqlx::query_scalar(&format!(
        "SELECT recipient_id FROM notifications n WHERE {LIVE} \
         GROUP BY recipient_id HAVING COUNT(*) > ?"
    ))
    .bind(PER_RECIPIENT_CAP)
    .fetch_all(pool)
    .await?;
    for recipient in over {
        let excess: Vec<(i64, String)> = sqlx::query_as(&format!(
            "SELECT id, updated_at FROM notifications n WHERE recipient_id = ? AND {LIVE} \
             ORDER BY updated_at DESC, id DESC LIMIT -1 OFFSET ?"
        ))
        .bind(&recipient)
        .bind(PER_RECIPIENT_CAP)
        .fetch_all(pool)
        .await?;
        // Rows bumped above the first excess row since the read are kept.
        let Some((first_id, first_at)) = excess.first().cloned() else {
            continue;
        };
        let ids: Vec<i64> = excess.into_iter().map(|(id, _)| id).collect();
        for batch in ids.chunks(PRUNE_BATCH) {
            total += delete_ids(
                pool,
                batch,
                "updated_at < ?2 OR (updated_at = ?2 AND id <= ?3)",
                &first_at,
                Some(first_id),
            )
            .await?;
            tokio::task::yield_now().await;
        }
    }
    Ok(total)
}

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationGame {
    pub id: String,
    pub title: String,
    pub thumbnail_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub id: String,
    pub kind: &'static str,
    pub actors: Vec<UserRef>,
    pub actor_count: i64,
    pub event_count: i64,
    pub game: Option<NotificationGame>,
    pub comment_id: Option<String>,
    pub excerpt: Option<String>,
    pub owns_thread: bool,
    pub creator_heart: bool,
    pub read: bool,
    pub created_at: String,
    pub updated_at: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPage {
    pub items: Vec<Notification>,
    pub next_cursor: Option<String>,
    pub unread: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnreadCount {
    pub unread: i64,
    pub latest_at: Option<String>,
    pub poll_after_secs: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettings {
    pub comments: bool,
    pub replies: bool,
    pub hearts: bool,
    pub follows: bool,
    pub new_games: bool,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            comments: true,
            replies: true,
            hearts: true,
            follows: true,
            new_games: true,
        }
    }
}

/// A position in the `updatedAt desc, id desc` order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cursor {
    pub updated_at: String,
    pub id: i64,
}

impl Cursor {
    /// Opaque form: base64url (no padding) of `"{updatedAt}|{id}"`.
    pub fn encode(&self) -> String {
        b64url_encode(format!("{}|{}", self.updated_at, self.id).as_bytes())
    }

    /// `None` when malformed.
    pub fn decode(s: &str) -> Option<Cursor> {
        let raw = String::from_utf8(b64url_decode(s)?).ok()?;
        let (ts, id) = raw.rsplit_once('|')?;
        let ts = DateTime::parse_from_rfc3339(ts).ok()?.with_timezone(&Utc);
        let id: i64 = parse_positive_id(id)?;
        Some(Cursor {
            updated_at: stamp(ts),
            id,
        })
    }
}

/// A positive decimal integer (ASCII digits only), as used for notification ids.
pub fn parse_positive_id(s: &str) -> Option<i64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse::<i64>().ok().filter(|n| *n > 0)
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn b64url_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        let chars = chunk.len() + 1;
        for i in 0..chars {
            out.push(B64[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    if s.is_empty() || s.len() % 4 == 1 || s.len() > 256 {
        return None;
    }
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    for chunk in s.as_bytes().chunks(4) {
        let mut n: u32 = 0;
        for (i, c) in chunk.iter().enumerate() {
            let v = B64.iter().position(|x| x == c)? as u32;
            n |= v << (18 - 6 * i);
        }
        let bytes = chunk.len() - 1;
        for i in 0..bytes {
            out.push((n >> (16 - 8 * i)) as u8);
        }
    }
    Some(out)
}

/// Shared visibility filter (binds `?1` = recipient).
const VISIBLE: &str = "(n.game_id IS NULL OR g.published = 1 OR g.owner_id = ?1) \
     AND EXISTS (SELECT 1 FROM notification_events e WHERE e.notification_id = n.id \
       AND e.retracted_at IS NULL)";

/// `(unread, latestAt)`: visible unread notifications (capped at [`UNREAD_CAP`]).
pub async fn unread_count(db: &SqlitePool, recipient: &str) -> sqlx::Result<(i64, Option<String>)> {
    sqlx::query_as(&format!(
        "SELECT COUNT(*), MAX(updated_at) FROM ( \
           SELECT n.updated_at FROM notifications n LEFT JOIN games g ON g.id = n.game_id \
           WHERE n.recipient_id = ?1 AND n.read_at IS NULL AND {VISIBLE} \
           ORDER BY n.updated_at DESC LIMIT ?2)"
    ))
    .bind(recipient)
    .bind(UNREAD_CAP)
    .fetch_one(db)
    .await
}

/// Mark the recipient's unread rows with `updated_at <= up_to` (and in `ids`, when given) as
/// read. `up_to` must already be in the stored format. Returns the number of rows changed.
pub async fn mark_read(
    db: &SqlitePool,
    recipient: &str,
    ids: Option<&[i64]>,
    up_to: &str,
    now: DateTime<Utc>,
) -> sqlx::Result<u64> {
    let ids_json = ids.map(|ids| serde_json::to_string(ids).unwrap_or_else(|_| "[]".into()));
    Ok(sqlx::query(
        "UPDATE notifications SET read_at = ?2 \
         WHERE recipient_id = ?1 AND read_at IS NULL AND updated_at <= ?3 \
         AND (?4 IS NULL OR id IN (SELECT value FROM json_each(?4)))",
    )
    .bind(recipient)
    .bind(stamp(now))
    .bind(up_to)
    .bind(ids_json)
    .execute(db)
    .await?
    .rows_affected())
}

pub async fn load_settings(db: &SqlitePool, user_id: &str) -> sqlx::Result<NotificationSettings> {
    let row: Option<(bool, bool, bool, bool, bool)> = sqlx::query_as(
        "SELECT comments, replies, hearts, follows, new_games FROM notification_settings \
         WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    Ok(match row {
        None => NotificationSettings::default(),
        Some((comments, replies, hearts, follows, new_games)) => NotificationSettings {
            comments,
            replies,
            hearts,
            follows,
            new_games,
        },
    })
}

/// A partial settings update (`None` = unchanged).
#[derive(Debug, Clone, Copy, Default)]
pub struct SettingsPatch {
    pub comments: Option<bool>,
    pub replies: Option<bool>,
    pub hearts: Option<bool>,
    pub follows: Option<bool>,
    pub new_games: Option<bool>,
}

impl SettingsPatch {
    pub fn is_empty(&self) -> bool {
        self.comments.is_none()
            && self.replies.is_none()
            && self.hearts.is_none()
            && self.follows.is_none()
            && self.new_games.is_none()
    }
}

/// Apply a partial update atomically (one upsert; absent fields keep their value).
pub async fn update_settings(
    db: &SqlitePool,
    user_id: &str,
    patch: SettingsPatch,
    now: DateTime<Utc>,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO notification_settings \
           (user_id, comments, replies, hearts, follows, new_games, updated_at) \
         VALUES (?1, COALESCE(?2, 1), COALESCE(?3, 1), COALESCE(?4, 1), COALESCE(?5, 1), \
           COALESCE(?6, 1), ?7) \
         ON CONFLICT (user_id) DO UPDATE SET \
           comments = COALESCE(?2, comments), replies = COALESCE(?3, replies), \
           hearts = COALESCE(?4, hearts), follows = COALESCE(?5, follows), \
           new_games = COALESCE(?6, new_games), updated_at = ?7",
    )
    .bind(user_id)
    .bind(patch.comments)
    .bind(patch.replies)
    .bind(patch.hearts)
    .bind(patch.follows)
    .bind(patch.new_games)
    .bind(stamp(now))
    .execute(db)
    .await?;
    Ok(())
}

/// One list page for the recipient. `limit` must already be clamped (1–50).
pub async fn list_page(
    db: &SqlitePool,
    recipient: &str,
    unread_only: bool,
    cursor: Option<&Cursor>,
    limit: i64,
) -> sqlx::Result<(Vec<Notification>, Option<String>)> {
    let rows = sqlx::query(&format!(
        "SELECT n.id, n.kind, n.game_id, n.comment_id, n.read_at, n.created_at, n.updated_at, \
           g.title, g.owner_id, g.thumbnail_ext, g.thumbnail_version, \
           EXISTS (SELECT 1 FROM notification_events e WHERE e.notification_id = n.id \
             AND e.actor_id = g.owner_id AND e.retracted_at IS NULL) AS creator_heart \
         FROM notifications n LEFT JOIN games g ON g.id = n.game_id \
         WHERE n.recipient_id = ?1 AND {VISIBLE} \
           AND (?2 = 0 OR n.read_at IS NULL) \
           AND (?3 IS NULL OR n.updated_at < ?3 OR (n.updated_at = ?3 AND n.id < ?4)) \
         ORDER BY n.updated_at DESC, n.id DESC LIMIT ?5"
    ))
    .bind(recipient)
    .bind(i64::from(unread_only))
    .bind(cursor.map(|c| c.updated_at.as_str()))
    .bind(cursor.map(|c| c.id))
    .bind(limit + 1)
    .fetch_all(db)
    .await?;

    struct Base {
        id: i64,
        kind: Kind,
        game_id: Option<String>,
        comment_id: Option<String>,
        read: bool,
        created_at: String,
        updated_at: String,
        title: Option<String>,
        thumb_ext: Option<String>,
        thumb_version: Option<i64>,
        creator_heart: bool,
    }
    let mut bases = Vec::with_capacity(rows.len());
    for r in &rows {
        let kind: String = r.try_get("kind")?;
        // The CHECK constraint keeps unknown kinds out; skip defensively anyway.
        let Some(kind) = Kind::parse(&kind) else {
            continue;
        };
        bases.push(Base {
            id: r.try_get("id")?,
            kind,
            game_id: r.try_get("game_id")?,
            comment_id: r.try_get("comment_id")?,
            read: r.try_get::<Option<String>, _>("read_at")?.is_some(),
            created_at: r.try_get("created_at")?,
            updated_at: r.try_get("updated_at")?,
            title: r.try_get("title")?,
            thumb_ext: r.try_get("thumbnail_ext")?,
            thumb_version: r.try_get("thumbnail_version")?,
            creator_heart: r.try_get("creator_heart")?,
        });
    }
    let more = bases.len() as i64 > limit;
    bases.truncate(limit.max(0) as usize);
    let next_cursor = if more {
        bases.last().map(|b| {
            Cursor {
                updated_at: b.updated_at.clone(),
                id: b.id,
            }
            .encode()
        })
    } else {
        None
    };
    if bases.is_empty() {
        return Ok((Vec::new(), next_cursor));
    }

    let ids: Vec<i64> = bases.iter().map(|b| b.id).collect();
    let ids_json = serde_json::to_string(&ids).unwrap_or_else(|_| "[]".into());

    // Counts.
    let counts: HashMap<i64, (i64, i64)> = sqlx::query_as::<_, (i64, i64, i64)>(
        "SELECT notification_id, COUNT(*), COUNT(DISTINCT actor_id) FROM notification_events \
         WHERE notification_id IN (SELECT value FROM json_each(?1)) AND retracted_at IS NULL \
         GROUP BY notification_id",
    )
    .bind(&ids_json)
    .fetch_all(db)
    .await?
    .into_iter()
    .map(|(id, events, actors)| (id, (events, actors)))
    .collect();

    // Up to 3 most recent distinct actors (ties by insertion order, newest first).
    let actor_rows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT notification_id, actor_id FROM ( \
           SELECT notification_id, actor_id, ROW_NUMBER() OVER (PARTITION BY notification_id \
             ORDER BY MAX(created_at) DESC, MAX(id) DESC) AS rn \
           FROM notification_events WHERE notification_id IN (SELECT value FROM json_each(?1)) \
             AND retracted_at IS NULL \
           GROUP BY notification_id, actor_id) \
         WHERE rn <= 3 ORDER BY notification_id, rn",
    )
    .bind(&ids_json)
    .fetch_all(db)
    .await?;
    let mut actors_of: HashMap<i64, Vec<String>> = HashMap::new();
    for (nid, actor) in actor_rows {
        actors_of.entry(nid).or_default().push(actor);
    }

    // Newest comment of comment/reply groups.
    let threaded: Vec<i64> = bases
        .iter()
        .filter(|b| matches!(b.kind, Kind::Comment | Kind::Reply))
        .map(|b| b.id)
        .collect();
    let mut newest: HashMap<i64, String> = HashMap::new();
    if !threaded.is_empty() {
        let threaded_json = serde_json::to_string(&threaded).unwrap_or_else(|_| "[]".into());
        newest = sqlx::query_as::<_, (i64, String)>(
            "SELECT notification_id, comment_id FROM ( \
               SELECT notification_id, comment_id, ROW_NUMBER() OVER ( \
                 PARTITION BY notification_id ORDER BY created_at DESC, id DESC) AS rn \
               FROM notification_events \
               WHERE notification_id IN (SELECT value FROM json_each(?1)) \
                 AND comment_id IS NOT NULL AND retracted_at IS NULL) \
             WHERE rn = 1",
        )
        .bind(&threaded_json)
        .fetch_all(db)
        .await?
        .into_iter()
        .collect();
    }

    // Target comments (excerpts) and thread roots (ownsThread).
    let target_of = |b: &Base| -> Option<String> {
        match b.kind {
            Kind::Comment | Kind::Reply => newest.get(&b.id).cloned(),
            Kind::Heart => b.comment_id.clone(),
            Kind::Follow | Kind::GamePublished => None,
        }
    };
    let mut comment_ids: HashSet<String> = HashSet::new();
    for b in &bases {
        if let Some(c) = target_of(b) {
            comment_ids.insert(c);
        }
        if b.kind == Kind::Reply
            && let Some(root) = &b.comment_id
        {
            comment_ids.insert(root.clone());
        }
    }
    let mut comments: HashMap<String, (String, String)> = HashMap::new();
    if !comment_ids.is_empty() {
        let cj = serde_json::to_string(&comment_ids.iter().collect::<Vec<_>>())
            .unwrap_or_else(|_| "[]".into());
        comments = sqlx::query_as::<_, (String, String, String)>(
            "SELECT id, user_id, substr(body, 1, ?2) FROM comments \
             WHERE id IN (SELECT value FROM json_each(?1))",
        )
        .bind(&cj)
        .bind(EXCERPT_CHARS)
        .fetch_all(db)
        .await?
        .into_iter()
        .map(|(id, user, body)| (id, (user, body)))
        .collect();
    }

    // Users: every listed actor plus the recipient (for the follow path).
    let mut user_ids: HashSet<String> = actors_of.values().flatten().cloned().collect();
    user_ids.insert(recipient.to_string());
    let uj =
        serde_json::to_string(&user_ids.iter().collect::<Vec<_>>()).unwrap_or_else(|_| "[]".into());
    let user_rows = sqlx::query(
        "SELECT id, username, display_name, avatar_ext, avatar_version FROM users \
         WHERE id IN (SELECT value FROM json_each(?1))",
    )
    .bind(&uj)
    .fetch_all(db)
    .await?;
    let mut users: HashMap<String, UserRef> = HashMap::new();
    for r in &user_rows {
        let u = user_ref_from_row(r, "")?;
        users.insert(u.id.clone(), u);
    }
    let recipient_name = users
        .get(recipient)
        .map(|u| u.username.clone())
        .unwrap_or_default();

    let mut items = Vec::with_capacity(bases.len());
    for b in &bases {
        let (events, actor_count) = counts.get(&b.id).copied().unwrap_or((0, 0));
        let actors: Vec<UserRef> = actors_of
            .get(&b.id)
            .map(|v| v.iter().filter_map(|a| users.get(a).cloned()).collect())
            .unwrap_or_default();
        let game = match (&b.game_id, &b.title) {
            (Some(gid), Some(title)) => Some(NotificationGame {
                id: gid.clone(),
                title: title.clone(),
                thumbnail_url: thumbnail_url(
                    gid,
                    b.thumb_ext.as_deref(),
                    b.thumb_version.unwrap_or(0),
                ),
            }),
            _ => None,
        };
        let comment_id = target_of(b);
        let excerpt = comment_id
            .as_ref()
            .and_then(|c| comments.get(c))
            .map(|(_, body)| body.clone());
        let owns_thread = b.kind == Kind::Reply
            && b.comment_id
                .as_ref()
                .and_then(|root| comments.get(root))
                .is_some_and(|(author, _)| author == recipient);
        let gid = b.game_id.as_deref().unwrap_or("");
        let path = match b.kind {
            Kind::Comment | Kind::Reply | Kind::Heart => match &comment_id {
                Some(c) => format!("/games/{gid}?comment={c}"),
                None => format!("/games/{gid}"),
            },
            Kind::Follow => format!("/u/{recipient_name}/followers"),
            Kind::GamePublished => format!("/games/{gid}"),
        };
        let event_count = match b.kind {
            Kind::Comment | Kind::Reply => events,
            _ => actor_count,
        };
        items.push(Notification {
            id: b.id.to_string(),
            kind: b.kind.as_str(),
            actors,
            actor_count,
            event_count,
            game,
            comment_id,
            excerpt,
            owns_thread,
            creator_heart: b.kind == Kind::Heart && b.creator_heart,
            read: b.read,
            created_at: b.created_at.clone(),
            updated_at: b.updated_at.clone(),
            path,
        });
    }
    Ok((items, next_cursor))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64url_round_trip() {
        for s in ["", "a", "ab", "abc", "abcd", "2026-01-01T00:00:00.000Z|42"] {
            let e = b64url_encode(s.as_bytes());
            assert!(!e.contains('=') && !e.contains('+') && !e.contains('/'));
            if !s.is_empty() {
                assert_eq!(b64url_decode(&e).unwrap(), s.as_bytes());
            }
        }
        assert!(b64url_decode("a").is_none());
        assert!(b64url_decode("ab$c").is_none());
    }

    #[test]
    fn cursor_round_trip_and_rejects() {
        let c = Cursor {
            updated_at: "2026-01-01T00:00:00.000Z".into(),
            id: 7,
        };
        assert_eq!(Cursor::decode(&c.encode()), Some(c));
        for bad in [
            "",
            "!!!",
            "abc",
            &b64url_encode(b"nope|1"),
            &b64url_encode(b"2026-01-01T00:00:00.000Z|0"),
        ] {
            assert!(Cursor::decode(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn kinds() {
        for k in Kind::ALL {
            assert_eq!(Kind::parse(k.as_str()), Some(k));
        }
        assert_eq!(Kind::GamePublished.setting_column(), "new_games");
        assert_eq!(Kind::parse("x"), None);
    }

    #[test]
    fn positive_ids() {
        assert_eq!(parse_positive_id("12"), Some(12));
        for bad in ["", "0", "-1", "+1", "1.0", "abc", "99999999999999999999"] {
            assert_eq!(parse_positive_id(bad), None, "{bad}");
        }
    }
}
