//! Non-blocking per-key claims (used to serialise bundle replaces per game).

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
}
