import { useLayoutEffect, useRef } from "react";

/** Each committed scope owns its lookups, even after switching away and back. */
export function usePastedPullRequestScope(scope: string) {
  const current = useRef<{
    scope: string;
    active: boolean;
    inFlight: Set<number>;
  } | null>(null);
  useLayoutEffect(() => {
    const lifetime = { scope, active: true, inFlight: new Set<number>() };
    current.current = lifetime;
    return () => {
      lifetime.active = false;
      current.current = null;
    };
  }, [scope]);
  return current;
}
