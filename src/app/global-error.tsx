"use client";

import { useEffect } from "react";

/**
 * Shown when the root layout itself broke: it replaces the whole document,
 * without the app's styles, so it carries its own few, and follows the
 * device's light or dark look.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <html lang="ja" style={{ colorScheme: "light dark" }}>
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          padding: "0 24px",
          textAlign: "center",
          fontFamily: "system-ui, sans-serif",
          background: "Canvas",
          color: "CanvasText",
        }}
      >
        <title>Memoca</title>
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>画面を表示できませんでした</h1>
        <p style={{ fontSize: 14, opacity: 0.7, maxWidth: 360, lineHeight: 1.6, margin: 0 }}>
          思わぬ問題が起きました。読み込み直してください。
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            font: "inherit",
            fontSize: 14,
            padding: "6px 14px",
            borderRadius: 8,
            border: "1px solid color-mix(in srgb, CanvasText 25%, transparent)",
            background: "transparent",
            color: "inherit",
            cursor: "pointer",
          }}
        >
          読み込み直す
        </button>
      </body>
    </html>
  );
}
