// Who may do what (contract: handoff/access-control-contract.md §2). The catalogue is fixed in code;
// roles and per-user exceptions only switch these keys on or off. Pure data and functions: the API
// resolves a user's permissions with these, the desk shows the same list.

export type PermissionGroup = "pages" | "actions";

export interface Permission {
  key: string;
  group: PermissionGroup;
  label: string;
  description: string;
}

export const PERMISSIONS = [
  // ─── Pages ───
  { key: "page.dashboard", group: "pages", label: "Dashboard", description: "Open the dashboard." },
  { key: "page.rejected_news", group: "pages", label: "Rejected news", description: "Open the list of rejected stories." },
  { key: "page.post_studio.x", group: "pages", label: "Post Studio: X", description: "Open the X desk in Post Studio." },
  { key: "page.post_studio.instagram", group: "pages", label: "Post Studio: Instagram", description: "Open the Instagram desk in Post Studio." },
  { key: "page.post_studio.facebook", group: "pages", label: "Post Studio: Facebook", description: "Open the Facebook desk in Post Studio." },
  { key: "page.post_studio.youtube", group: "pages", label: "Post Studio: YouTube", description: "Open the YouTube desk in Post Studio." },
  { key: "page.web_scraper", group: "pages", label: "Web Scraper", description: "Open the Web Scraper (trends from the open web)." },
  { key: "page.video_studio", group: "pages", label: "Video Studio", description: "Open the Video Studio." },
  { key: "page.settings", group: "pages", label: "Settings", description: "Open Settings, and change the hashtag rules and the handle directory." },
  { key: "page.users", group: "pages", label: "Users", description: "Open the users and access pages." },
  // ─── Actions ───
  { key: "story.take_in", group: "actions", label: "Take in rejected stories", description: "Take a rejected story back into the queue." },
  { key: "draft.edit", group: "actions", label: "Edit drafts", description: "Change a draft's text, hashtags and mentions." },
  { key: "draft.card", group: "actions", label: "Change cards", description: "Change or upload a draft's card." },
  { key: "draft.approve", group: "actions", label: "Approve drafts", description: "Approve a story or draft for the digital desk." },
  { key: "draft.reject", group: "actions", label: "Reject drafts", description: "Reject a story or draft." },
  { key: "post.publish", group: "actions", label: "Post to platform", description: "Send a draft to the platform (X), retry a failed post, and decline a draft." },
  { key: "post.mark_posted", group: "actions", label: "Mark as posted", description: "Record a post that was made by hand on the platform." },
  { key: "post.undo", group: "actions", label: "Undo and recall posts", description: "Undo a post in its undo window, or recall a published post." },
  { key: "trends.refresh", group: "actions", label: "Refresh trends", description: "Ask the Web Scraper to pull its sources now." },
  { key: "trends.draft", group: "actions", label: "Draft from trends", description: "Create a draft from a Web Scraper item." },
  { key: "trends.watch", group: "actions", label: "Watch keywords", description: "Keep your own keyword watch list in the Web Scraper." },
  { key: "card_template.own", group: "actions", label: "Own card backgrounds", description: "Upload and lay out your own card backgrounds." },
  { key: "video.export", group: "actions", label: "Export videos", description: "Export videos from the Video Studio." },
  { key: "users.manage", group: "actions", label: "Manage users", description: "Add users, change their role, platforms, exceptions and access." },
  { key: "roles.manage", group: "actions", label: "Manage roles", description: "Create, edit, reset and delete roles." },
  { key: "audit.view", group: "actions", label: "View change history", description: "See the history of role and user changes." },
] as const satisfies readonly Permission[];

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];

export const PERMISSION_KEYS: readonly PermissionKey[] = PERMISSIONS.map((p) => p.key);
const KEY_SET: ReadonlySet<string> = new Set(PERMISSION_KEYS);
const BY_KEY: ReadonlyMap<string, Permission> = new Map(PERMISSIONS.map((p) => [p.key, p]));

export const isPermissionKey = (key: string): key is PermissionKey => KEY_SET.has(key);
export const permissionLabel = (key: PermissionKey): string => BY_KEY.get(key)?.label ?? key;

// ─── Built-in roles ──────────────────────────────────────────────────────────

export const BUILT_IN_ROLES = ["admin", "editor", "operator", "viewer"] as const;
export type BuiltInRole = (typeof BUILT_IN_ROLES)[number];
export const isBuiltInRole = (key: string): key is BuiltInRole => (BUILT_IN_ROLES as readonly string[]).includes(key);

export const BUILT_IN_ROLE_INFO: Record<BuiltInRole, { label: string; description: string; platformScoped: boolean }> = {
  admin: { label: "Admin", description: "Everything, including users and roles.", platformScoped: false },
  editor: { label: "Chief Editor", description: "Every page and action except managing users and roles.", platformScoped: false },
  operator: { label: "Digital Team", description: "Posts on their own platforms.", platformScoped: true },
  viewer: { label: "Viewer", description: "Reads the desk; keeps their own keyword watch and card backgrounds.", platformScoped: false },
};

/** The admin role can never lose these: someone must always be able to fix access. */
export const ADMIN_ALWAYS: readonly PermissionKey[] = ["users.manage", "roles.manage"];

const POST_STUDIO: PermissionKey[] = ["page.post_studio.x", "page.post_studio.instagram", "page.post_studio.facebook", "page.post_studio.youtube"];

export const DEFAULT_ROLE_PERMISSIONS: Record<BuiltInRole, readonly PermissionKey[]> = {
  admin: PERMISSION_KEYS,
  editor: PERMISSION_KEYS.filter((k) => k !== "users.manage" && k !== "roles.manage"),
  operator: [
    "page.dashboard", "page.rejected_news", ...POST_STUDIO, "page.web_scraper", "page.video_studio",
    "story.take_in", "draft.edit", "draft.card", "post.publish", "post.mark_posted", "post.undo",
    "trends.draft", "trends.watch", "card_template.own", "video.export",
  ],
  viewer: ["page.dashboard", "page.rejected_news", ...POST_STUDIO, "page.web_scraper", "trends.watch", "card_template.own"],
};

export interface PermissionSetting {
  permission: string;
  allowed: boolean;
}

/**
 * A role's allowed set. Stored rows win; a missing row is the built-in default for a built-in
 * role and "not allowed" for a custom one. The admin role always keeps ADMIN_ALWAYS.
 */
export function rolePermissionSet(roleKey: string, builtIn: boolean, rows: readonly PermissionSetting[]): Set<PermissionKey> {
  const stored = new Map(rows.filter((r) => isPermissionKey(r.permission)).map((r) => [r.permission, r.allowed]));
  const defaults = builtIn && isBuiltInRole(roleKey) ? new Set<string>(DEFAULT_ROLE_PERMISSIONS[roleKey]) : new Set<string>();
  const out = new Set<PermissionKey>();
  for (const key of PERMISSION_KEYS) if (stored.get(key) ?? defaults.has(key)) out.add(key);
  if (roleKey === "admin") for (const key of ADMIN_ALWAYS) out.add(key);
  return out;
}

/** Effective permissions: a user's exception if there is one, else the role's setting. */
export function effectivePermissionSet(role: ReadonlySet<PermissionKey>, overrides: readonly PermissionSetting[]): Set<PermissionKey> {
  const out = new Set(role);
  for (const o of overrides) {
    if (!isPermissionKey(o.permission)) continue;
    if (o.allowed) out.add(o.permission);
    else out.delete(o.permission);
  }
  return out;
}

/** "Video Editor" → "video-editor". Empty when the label has no Latin letters or digits. */
export function roleKeyFromLabel(label: string): string {
  return label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}
