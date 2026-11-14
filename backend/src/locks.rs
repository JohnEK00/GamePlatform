//! Non-blocking per-key claims (used to serialise bundle replaces per game).

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub struct KeyLocks {
    held: Arc<Mutex<HashSet<String>>>,
}

/// Releases the claim on drop.
pub struct KeyGuard {
    held: Arc<Mutex<HashSet<String>>>,
    key: String,
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
}
