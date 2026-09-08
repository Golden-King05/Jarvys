import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { baseUrlStorage, tokenStorage } from "./storage";

interface AuthContextValue {
  loading: boolean;
  token: string | null;
  baseUrl: string;
  setBaseUrl: (url: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState<string | null>(null);
  const [baseUrl, setBaseUrlState] = useState("");

  useEffect(() => {
    (async () => {
      const [storedToken, storedBaseUrl] = await Promise.all([
        tokenStorage.get(),
        baseUrlStorage.get(),
      ]);
      setToken(storedToken);
      setBaseUrlState(storedBaseUrl);
      setLoading(false);
    })();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      loading,
      token,
      baseUrl,
      setBaseUrl: async (url: string) => {
        await baseUrlStorage.set(url);
        setBaseUrlState(url);
      },
      login: async (email: string, password: string) => {
        const { token: newToken } = await api.login(baseUrl, email, password);
        await tokenStorage.set(newToken);
        setToken(newToken);
      },
      register: async (email: string, password: string) => {
        const { token: newToken } = await api.register(baseUrl, email, password);
        await tokenStorage.set(newToken);
        setToken(newToken);
      },
      logout: async () => {
        await tokenStorage.clear();
        setToken(null);
      },
    }),
    [loading, token, baseUrl]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
