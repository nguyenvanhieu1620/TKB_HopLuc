import { createContext, useContext, useState, ReactNode } from "react";
import axiosClient from "../api/axiosClient";
import { AuthUser } from "../types";

interface AuthContextValue {
  user: AuthUser | null;
  login: (username: string, password: string) => Promise<AuthUser>;
  logout: () => void;
  isAdmin: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(() => {
    const saved = localStorage.getItem("tkb_user");
    return saved ? (JSON.parse(saved) as AuthUser) : null;
  });

  async function login(username: string, password: string): Promise<AuthUser> {
    const res = await axiosClient.post<{ token: string; user: AuthUser }>("/auth/login", { username, password });
    localStorage.setItem("tkb_token", res.data.token);
    localStorage.setItem("tkb_user", JSON.stringify(res.data.user));
    setUser(res.data.user);
    return res.data.user;
  }

  function logout(): void {
    localStorage.removeItem("tkb_token");
    localStorage.removeItem("tkb_user");
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, login, logout, isAdmin: user?.role === "Admin" }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth phải được dùng bên trong AuthProvider");
  return ctx;
}
