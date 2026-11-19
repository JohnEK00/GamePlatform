//! Non-blocking per-key claims (used to serialise bundle replaces per game), and blocking
//! per-user locks for profile image writes ([`UserLocks`]).

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use tokio::sync::{Notify, Semaphore};

#[derive(Clone, Default)]
pub struct KeyLocks {
    held: Arc<Mutex<HashSet<String>>>,
    /// Test hook ([`KeyLocks::install_gate`]); `None` in production.
    gate: Arc<Mutex<Option<Arc<ClaimGate>>>>,
}

/// Releases the claim on drop.
pub struct KeyGuard {
    held: Arc<Mutex<HashSet<String>>>,
    key: String,
}

/// A one-shot pause point for tests: the next claimer to reach [`KeyLocks::after_claim`]
/// signals [`ClaimGate::entered`] and then waits, holding its claim, until
/// [`ClaimGate::release`]. Lets a test overlap two requests deterministically, with no sleeps.
#[doc(hidden)]
pub struct ClaimGate {
    entered: Notify,
    release: Semaphore,
}

impl Default for ClaimGate {
    fn default() -> Self {
        Self {
            entered: Notify::new(),
            release: Semaphore::new(0),
        }
    }
}

impl ClaimGate {
    /// Resolves once a claimer is parked at the gate (holding its claim).
    pub async fn entered(&self) {
        self.entered.notified().await;
    }

    /// Let the parked claimer continue.
    pub fn release(&self) {
        self.release.add_permits(1);
    }
}

impl KeyLocks {
    pub fn new() -> Self {
        Self::default()
    }

    /// Claim `key`, or `None` if another task currently holds it.
    pub fn try_claim(&self, key: &str) -> Option<KeyGuard> {
        let mut set = self.held.lock().unwrap_or_else(|p| p.into_inner());
        if !set.insert(key.to_string()) {
            return None;
        }
        Some(KeyGuard {
            held: self.held.clone(),
            key: key.to_string(),
        })
    }

    /// Test hook: the next [`KeyLocks::after_claim`] call pauses at the returned gate.
    #[doc(hidden)]
    pub fn install_gate(&self) -> Arc<ClaimGate> {
        let gate = Arc::new(ClaimGate::default());
        *self.gate.lock().unwrap_or_else(|p| p.into_inner()) = Some(gate.clone());
        gate
    }

    /// Called by a claimer right after a successful [`KeyLocks::try_claim`]. A no-op unless a
    /// test installed a gate (taken by the first caller only).
    pub async fn after_claim(&self) {
        let gate = self.gate.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(gate) = gate {
            gate.entered.notify_one();
            if let Ok(permit) = gate.release.acquire().await {
                permit.forget();
            }
        }
    }
}

/// Review 11 L5: blocking per-user locks that serialise writes to a user's profile images
/// (avatar and banner upload, banner delete, admin `clearProfile`). Each one holds the lock
/// across both its file operation and its `UPDATE users`, so a clear can't land between an
/// upload's file write and the row update. Keys hash onto a fixed set of async mutexes, so
/// memory stays bounded. Two users who share a stripe just wait for each other briefly.
#[derive(Clone)]
pub struct UserLocks {
    stripes: Arc<[tokio::sync::Mutex<()>]>,
    /// Test hook ([`UserLocks::install_gate`]); `None` in production.
    gate: Arc<Mutex<Option<Arc<ClaimGate>>>>,
}

const USER_LOCK_STRIPES: usize = 64;

impl Default for UserLocks {
    fn default() -> Self {
        Self {
            stripes: (0..USER_LOCK_STRIPES)
                .map(|_| tokio::sync::Mutex::new(()))
                .collect(),
            gate: Arc::default(),
        }
    }
}

impl UserLocks {
    pub fn new() -> Self {
        Self::default()
    }

    /// Wait for the lock on `user_id`. It is held until the guard is dropped.
    pub async fn lock(&self, user_id: &str) -> tokio::sync::MutexGuard<'_, ()> {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        user_id.hash(&mut h);
        let i = (h.finish() % self.stripes.len() as u64) as usize;
        self.stripes[i].lock().await
    }

    /// Test hook: the next [`UserLocks::checkpoint`] call pauses at the returned gate.
    #[doc(hidden)]
    pub fn install_gate(&self) -> Arc<ClaimGate> {
        let gate = Arc::new(ClaimGate::default());
        *self.gate.lock().unwrap_or_else(|p| p.into_inner()) = Some(gate.clone());
        gate
    }

    /// Called while a lock is held, between the file write and the row update. A no-op
    /// unless a test installed a gate (only the first caller takes it).
    pub async fn checkpoint(&self) {
        let gate = self.gate.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(gate) = gate {
            gate.entered.notify_one();
            if let Ok(permit) = gate.release.acquire().await {
                permit.forget();
            }
        }
    }
}

impl Drop for KeyGuard {
    fn drop(&mut self) {
        let mut set = self.held.lock().unwrap_or_else(|p| p.into_inner());
        set.remove(&self.key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claim_is_exclusive_until_dropped() {
        let l = KeyLocks::new();
        let g = l.try_claim("a").unwrap();
        assert!(l.try_claim("a").is_none());
        assert!(l.try_claim("b").is_some());
        drop(g);
        assert!(l.try_claim("a").is_some());
    }

    #[tokio::test]
    async fn gate_is_one_shot() {
        let l = KeyLocks::new();
        // No gate: returns at once.
        l.after_claim().await;
        let gate = l.install_gate();
        let l2 = l.clone();
        let waiter = tokio::spawn(async move { l2.after_claim().await });
        gate.entered().await;
        // The gate was taken by the first caller; others pass straight through.
        l.after_claim().await;
        assert!(!waiter.is_finished());
        gate.release();
        waiter.await.unwrap();
    }

    #[tokio::test]
    async fn user_lock_blocks_the_same_user_only_until_dropped() {
        let l = UserLocks::new();
        let g = l.lock("u1").await;
        let l2 = l.clone();
        let waiter = tokio::spawn(async move {
            let _g = l2.lock("u1").await;
        });
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());
        drop(g);
        waiter.await.unwrap();
    }
}
