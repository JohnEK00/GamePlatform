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
        };
        match create_game_record(state, &owner, new, bytes, None).await {
            Ok(id) => println!("seeded {} -> /play/{id}", zip.display()),
            Err(AppError::Validation(m)) => eprintln!("skipping {}: {m}", zip.display()),
            Err(e) => return Err(anyhow::anyhow!("seeding {}: {e}", zip.display())),
        }
    }
    Ok(())
}
