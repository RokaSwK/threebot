/** A site's logo, fetched by this gateway so no icon service sees which sites you use. */
export const siteIconUrl = (domain: string) => `/api/site-icon?domain=${encodeURIComponent(domain)}`;

const APP_DOMAINS: Record<string, string> = {
  airtable: "airtable.com", asana: "asana.com", atlassian: "atlassian.com", calendly: "calendly.com", clickup: "clickup.com", cloudflare: "cloudflare.com",
  confluence: "atlassian.com", discord: "discord.com", dropbox: "dropbox.com", figma: "figma.com", github: "github.com", gitlab: "gitlab.com", gmail: "mail.google.com",
  "google calendar": "calendar.google.com", "google docs": "docs.google.com", "google drive": "drive.google.com", "google sheets": "sheets.google.com",
  hubspot: "hubspot.com", intercom: "intercom.com", jira: "atlassian.com", linear: "linear.app", microsoft: "microsoft.com", "microsoft teams": "teams.microsoft.com",
  notion: "notion.so", obsidian: "obsidian.md", onedrive: "onedrive.live.com", outlook: "outlook.com", paypal: "paypal.com", reddit: "reddit.com", salesforce: "salesforce.com",
  sentry: "sentry.io", shopify: "shopify.com", slack: "slack.com", spotify: "spotify.com", stripe: "stripe.com", supabase: "supabase.com", telegram: "telegram.org",
  todoist: "todoist.com", trello: "trello.com", twitter: "x.com", vercel: "vercel.com", whatsapp: "whatsapp.com", x: "x.com", youtube: "youtube.com", zapier: "zapier.com", zoom: "zoom.us",
};

export const appDomain = (name: string) => APP_DOMAINS[name.trim().toLowerCase()] ?? null;
