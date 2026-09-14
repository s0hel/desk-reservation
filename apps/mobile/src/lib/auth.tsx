import * as SecureStore from "expo-secure-store";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { api, type Me, type TokenPair } from "./api";

const ACCESS = "deskflow.access";
const REFRESH = "deskflow.refresh";

type AuthState = {
  ready: boolean;
  token: string | null;
  me: Me | null;
  signIn: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
  /**
   * Re-read `/v1/me` after changing something it reports. `me` is held here rather
   * than in the query cache, so a screen that PATCHes it has no other way to make the
   * rest of the app agree with what the user just chose.
   */
  refreshMe: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);

  const persist = useCallback(async (pair: TokenPair) => {
    // Keychain / Android Keystore. With no MAM requirement (PRD Q2) this is the
    // appropriate ceiling for token storage (TDD §12.1).
    await SecureStore.setItemAsync(ACCESS, pair.access_token);
    await SecureStore.setItemAsync(REFRESH, pair.refresh_token);
    setToken(pair.access_token);
    setMe(await api.me(pair.access_token));
  }, []);

  const restore = useCallback(async () => {
    try {
      const stored = await SecureStore.getItemAsync(REFRESH);
      if (stored) await persist(await api.refresh(stored));
    } catch {
      await SecureStore.deleteItemAsync(ACCESS);
      await SecureStore.deleteItemAsync(REFRESH);
    } finally {
      setReady(true);
    }
  }, [persist]);

  useEffect(() => { void restore(); }, [restore]);

  const value = useMemo<AuthState>(() => ({
    ready, token, me,
    signIn: async (email: string) => { await persist(await api.devLogin(email)); },
    refreshMe: async () => { if (token) setMe(await api.me(token)); },
    signOut: async () => {
      await SecureStore.deleteItemAsync(ACCESS);
      await SecureStore.deleteItemAsync(REFRESH);
      setToken(null);
      setMe(null);
    },
  }), [ready, token, me, persist]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
