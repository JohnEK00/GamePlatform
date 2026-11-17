// `sqlx::migrate!` embeds `migrations/` at compile time. Without this, adding a migration file
// doesn't trigger a rebuild of the crate, and a stale binary runs without the new migration.
fn main() {
    println!("cargo:rerun-if-changed=migrations");
}
