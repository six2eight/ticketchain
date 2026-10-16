import { useEffect, useState } from "react";

/** Tiny hash router: #/events, #/events/3, #/tickets, #/market, #/organizer, #/scanner. */
export function navigate(path: string) {
  window.location.hash = path;
}

export function useRoute(): string[] {
  const read = () => (window.location.hash.replace(/^#\/?/, "") || "events").split("/");
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => {
      setRoute(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
