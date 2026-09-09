import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { tokenStorage } from "./storage";

// The hosted server (Render). No longer user-configurable — this was a
// local-dev leftover from before the server was hosted, and having to type
// a server address to log in was just friction with nothing useful behind
// it now that there's only ever one server to point at.
const BASE_URL = "https://jarvys-server-14df.onrender.com";

// "checking" while a wake-up ping is in flight, "warm" once the server has
// answered, "cold" if even the generous wake-up timeout was exceeded (still
// worth trying a real request — it may finish spinning up moments later).
export type ServerStatus = "checking" | "warm" | "cold";

interface AuthContextValue {
  loading: boolean;
  token: string | null;
  baseUrl: string;
  serverStatus: ServerStatus;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState<string | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerStatus>("checking");

  useEffect(() => {
    tokenStorage.get().then((storedToken) => {
      setToken(storedToken);
      setLoading(false);
    });
  }, []);

  // A returning user with a stored token skips straight to the authed app
  // without ever hitting the server (no login POST to incidentally wake
  // it), so their first real message can land on a fully spun-down Render
  // instance and time out. Pinging /health as soon as there's a token —
  // whether restored from storage or from a fresh login — gets Render
  // spinning up in the background well before that first message.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setServerStatus("checking");
    api.checkHealth(BASE_URL).then((ok) => {
      if (!cancelled) setServerStatus(ok ? "warm" : "cold");
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const value = useMemo<AuthContextValue>(
    () => ({
      loading,
      token,
      baseUrl: BASE_URL,
      serverStatus,
      login: async (email: string, password: string) => {
        const { token: newToken } = await api.login(BASE_URL, email, password);
        await tokenStorage.set(newToken);
        setToken(newToken);
      },
      register: async (email: string, password: string) => {
        const { token: newToken } = await api.register(BASE_URL, email, password);
        await tokenStorage.set(newToken);
        setToken(newToken);
      },
      logout: async () => {
        await tokenStorage.clear();
        setToken(null);
      },
    }),
    [loading, token, serverStatus]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
