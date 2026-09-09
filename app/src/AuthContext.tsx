import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { tokenStorage } from "./storage";

// The hosted server (Render). No longer user-configurable — this was a
// local-dev leftover from before the server was hosted, and having to type
// a server address to log in was just friction with nothing useful behind
// it now that there's only ever one server to point at.
const BASE_URL = "https://jarvys-server-14df.onrender.com";

interface AuthContextValue {
  loading: boolean;
  token: string | null;
  baseUrl: string;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    tokenStorage.get().then((storedToken) => {
      setToken(storedToken);
      setLoading(false);
    });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      loading,
      token,
      baseUrl: BASE_URL,
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
    [loading, token]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
