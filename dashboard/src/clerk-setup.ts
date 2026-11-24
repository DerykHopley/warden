// How Clerk's own screens (sign-in, the Organization switcher and its Manage screens) look and speak in Warden.
import type { ClerkProvider } from "@clerk/react";
import type { ComponentProps } from "react";

type ProviderProps = ComponentProps<typeof ClerkProvider>;

// They take Warden's tokens, so they follow light and dark with the rest of the page. Clerk mixes shades from these
// with color-mix(); a browser without it keeps Clerk's own. Not mapped: colorDanger and colorWarning (Warden has no
// error colour; severity colours are for severity only) and colorShadow (--shadow is a whole shadow, not a colour).
export const appearance = {
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
} satisfies ProviderProps["appearance"];

// A Clerk Organization is a Team in Warden (GLOSSARY.md), so Clerk's English says "Team" wherever it said
// "organization". Keys not set here keep Clerk's English.
export const localization = {
  organizationSwitcher: {
    action__createOrganization: "Create Team",
    action__manageOrganization: "Manage Team",
    action__openOrganizationSwitcher: "Open Team switcher",
    action__closeOrganizationSwitcher: "Close Team switcher",
    membershipListLabel: "Your Teams",
    notSelected: "No Team chosen",
  },
  createOrganization: {
    title: "Create Team",
    formButtonSubmit: "Create Team",
  },
  organizationList: {
    createOrganization: "Create Team",
    action__createOrganization: "Create Team",
  },
  organizationProfile: {
    navbar: {
      title: "Team",
      description: "Manage your Team.",
    },
    profilePage: {
      successMessage: "The Team has been updated.",
      dangerSection: {
        leaveOrganization: {
          title: "Leave Team",
          messageLine1:
            "Are you sure you want to leave this Team? You will lose access to it and its Warden.",
          successMessage: "You have left the Team.",
        },
        deleteOrganization: {
          title: "Delete Team",
          messageLine1: "Are you sure you want to delete this Team?",
          successMessage: "You have deleted the Team.",
        },
      },
    },
  },
} satisfies ProviderProps["localization"];
