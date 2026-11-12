import { useEffect, useState } from "react";
import { MOBILE_CHAT_QUERY } from "./chatBehavior";

/** True on narrow windows and touch devices, matching the chat composer's breakpoint. */
export function useMobileChat(): boolean {
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_CHAT_QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(MOBILE_CHAT_QUERY);
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return mobile;
}
