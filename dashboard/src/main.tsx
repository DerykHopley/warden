import { ClerkProvider } from "@clerk/react";
import { StrictMode, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root element");

// Clerk's sign-in, Organization switcher and its Manage screens take Warden's tokens, so they follow light and dark
// with the rest of the page. Clerk mixes shades from these with color-mix(); a browser without it keeps Clerk's own.
// Not mapped: colorDanger and colorWarning (Warden has no error colour; severity colours are for severity only) and
// colorShadow (--shadow is a whole shadow, not a colour).
const appearance = {
  variables: {
    colorPrimary: "var(--accent)",
    colorPrimaryForeground: "var(--accent-fg)",
    colorForeground: "var(--fg)",
    colorMutedForeground: "var(--muted)",
    colorBackground: "var(--surface)",
    colorMuted: "var(--chip)",
    colorInput: "var(--surface)",
    colorInputForeground: "var(--fg)",
    colorBorder: "var(--line)",
    colorNeutral: "var(--fg)",
    colorRing: "var(--accent)",
    colorSuccess: "var(--ok)",
    fontFamily: "var(--font-body)",
    fontFamilyButtons: "var(--font-body)",
    fontFamilyMono: "var(--font-mono)",
    borderRadius: "var(--radius)",
  },
} satisfies ComponentProps<typeof ClerkProvider>["appearance"];

createRoot(root).render(
  <StrictMode>
    <ClerkProvider
      publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY}
      appearance={appearance}
    >
      <App />
    </ClerkProvider>
  </StrictMode>,
);
