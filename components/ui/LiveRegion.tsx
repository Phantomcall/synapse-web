"use client";

import React, { useEffect, useState } from "react";
import { subscribeAnnouncements, type Announcement } from "@/lib/a11y/announce";

const SR_ONLY_STYLE: React.CSSProperties = {
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: 0,
  margin: "-1px",
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

export function LiveRegion() {
  const [politeMessage, setPoliteMessage] = useState("");
  const [assertiveMessage, setAssertiveMessage] = useState("");

  useEffect(() => {
    const unsubscribe = subscribeAnnouncements((announcement: Announcement) => {
      if (announcement.politeness === "assertive") {
        setAssertiveMessage(announcement.message);
      } else {
        setPoliteMessage(announcement.message);
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);

  return (
    <div style={SR_ONLY_STYLE}>
      <div role="status" aria-live="polite" aria-atomic="true" data-testid="live-region-polite">
        {politeMessage}
      </div>
      <div
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        data-testid="live-region-assertive"
      >
        {assertiveMessage}
      </div>
    </div>
  );
}
