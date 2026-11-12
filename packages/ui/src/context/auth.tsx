import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { isApiError } from "../api/client";
import type { LoginRequest, RegisterRequest, User } from "../api/types";
import { useApi } from "./config";

export const TOKEN_STORAGE_KEY = "webgame.token";

export function readStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
}

export type AuthState = {
  user: User | null;
  token: string | null;
  /** True while the stored token is being validated on startup. */
  loading: boolean;
  login: (req: LoginRequest) => Promise<User>;
  register: (req: RegisterRequest) => Promise<User>;
  logout: () => void;
  /** Replace the cached user (e.g. after PATCH /users/me). */
  setUser: (u: User) => void;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [token, setTokenState] = useState<string | null>(() => {
    const t = readStoredToken();
    api.setToken(t);
    return t;
  });
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState<boolean>(() => token !== null);

  const setToken = useCallback(
    (t: string | null) => {
      api.setToken(t);
      writeStoredToken(t);
      setTokenState(t);
    },
    [api],
  );

  const refresh = useCallback(async () => {
    if (!api.token) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      setUser(await api.me());
    } catch (e) {
      if (isApiError(e) && e.status === 401) {
        setToken(null);
        setUser(null);
      }
    } finally {
      setLoading(false);
    }
  }, [api, setToken]);

  useEffect(() => {
    api.setToken(token);
    void refresh();
    // only on mount / api change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  // Keep tabs in sync.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== TOKEN_STORAGE_KEY) return;
      api.setToken(e.newValue);
      setTokenState(e.newValue);
      if (!e.newValue) setUser(null);
      else void refresh();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [api, refresh]);

  const login = useCallback(
    async (req: LoginRequest) => {
      const res = await api.login(req);
      setToken(res.token);
      setUser(res.user);
      return res.user;
    },
    [api, setToken],
  );

  const register = useCallback(
    async (req: RegisterRequest) => {
      const res = await api.register(req);
      setToken(res.token);
      setUser(res.user);
      return res.user;
    },
    [api, setToken],
  );

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
  }, [setToken]);

  const value = useMemo<AuthState>(
    () => ({ user, token, loading, login, register, logout, setUser, refresh }),
    [user, token, loading, login, register, logout, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const c = useContext(AuthContext);
  if (!c) throw new Error("useAuth must be used inside <WebGameApp> / <WebGameProviders>");
  return c;
}
