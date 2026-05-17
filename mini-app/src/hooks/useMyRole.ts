import useSWR from "swr";
import { type MyRole, getMyRole } from "@/lib/api";

export interface UseMyRoleResult {
  role: string;
  isOperator: boolean;
  isAdmin: boolean;
  isLoading: boolean;
  error: unknown;
}

export function useMyRole(): UseMyRoleResult {
  const { data, error, isLoading } = useSWR<MyRole>("me", getMyRole, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
  const role = data?.role ?? "VIEWER";
  return {
    role,
    isOperator: role === "OPERATOR" || role === "TRADER" || role === "ADMIN",
    isAdmin: role === "ADMIN",
    isLoading,
    error,
  };
}
