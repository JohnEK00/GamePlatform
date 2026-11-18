-- F028: public profiles 2 (docs/ARCHITECTURE.md § F028 additions).

-- Profile banner: always "jpg" when set (re-encoded server-side); the version busts caches like avatar_version.
ALTER TABLE users ADD COLUMN banner_ext TEXT;
ALTER TABLE users ADD COLUMN banner_version INTEGER NOT NULL DEFAULT 0;

-- Profile links: a JSON array of {"label","url"} (0-3 items), validated by PATCH /api/users/me.
ALTER TABLE users ADD COLUMN links_json TEXT NOT NULL DEFAULT '[]';
