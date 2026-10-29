import { describe, expect, it } from "vitest";
import {
  ADMIN_ALWAYS, BUILT_IN_ROLES, DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, PERMISSION_KEYS, effectivePermissionSet, isPermissionKey,
  rolePermissionSet, roleKeyFromLabel, type PermissionKey,
} from "../src";

describe("permission catalogue", () => {
  it("has the contract's keys, each once, with a group, label and description", () => {
    expect(PERMISSION_KEYS).toHaveLength(26);
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
    for (const p of PERMISSIONS) {
      expect(["pages", "actions"]).toContain(p.group);
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
      expect(p.group === "pages").toBe(p.key.startsWith("page."));
    }
    expect(isPermissionKey("post.publish")).toBe(true);
    expect(isPermissionKey("post.delete_everything")).toBe(false);
  });

  it("gives the built-ins the contract's defaults", () => {
    expect(DEFAULT_ROLE_PERMISSIONS.admin).toEqual(PERMISSION_KEYS);
    expect([...PERMISSION_KEYS].filter((k) => !DEFAULT_ROLE_PERMISSIONS.editor.includes(k))).toEqual(["users.manage", "roles.manage"]);
    expect([...DEFAULT_ROLE_PERMISSIONS.operator].sort()).toEqual(
      [
        "page.dashboard", "page.rejected_news", "page.post_studio.x", "page.post_studio.instagram", "page.post_studio.facebook", "page.post_studio.youtube",
        "page.web_scraper", "page.video_studio", "story.take_in", "draft.edit", "draft.card", "post.publish", "post.mark_posted", "post.undo",
        "trends.draft", "trends.watch", "card_template.own", "video.export",
      ].sort(),
    );
    expect([...DEFAULT_ROLE_PERMISSIONS.viewer].filter((k) => !k.startsWith("page."))).toEqual(["trends.watch", "card_template.own"]);
    expect(DEFAULT_ROLE_PERMISSIONS.viewer).not.toContain("page.video_studio");
  });

  // What the old checks allowed: requireAct = any role but viewer (operator on its platforms),
  // requireRole(editor, admin) for the library and trend refresh, requireRole(admin) for users.
  it("reproduces the old role checks with the defaults", () => {
    const old = {
      act: { admin: true, editor: true, operator: true, viewer: false },
      editorOrAdmin: { admin: true, editor: true, operator: false, viewer: false },
      adminOnly: { admin: true, editor: false, operator: false, viewer: false },
    };
    const desk: PermissionKey[] = ["draft.edit", "draft.card", "post.publish", "post.mark_posted", "post.undo", "story.take_in", "trends.draft"];
    for (const role of BUILT_IN_ROLES) {
      const set = rolePermissionSet(role, true, []);
      for (const key of desk) expect([role, key, set.has(key)]).toEqual([role, key, old.act[role]]);
      // X desk reject: draft.reject or post.publish
      expect(set.has("draft.reject") || set.has("post.publish")).toBe(old.act[role]);
      expect(set.has("page.settings")).toBe(old.editorOrAdmin[role]);
      expect(set.has("trends.refresh")).toBe(old.editorOrAdmin[role]);
      expect(set.has("users.manage")).toBe(old.adminOnly[role]);
      // Unchecked before, so every role keeps them
      expect(set.has("trends.watch") && set.has("card_template.own")).toBe(true);
    }
  });
});

describe("rolePermissionSet / effectivePermissionSet", () => {
  it("lets stored rows win over the defaults, and custom roles start with nothing", () => {
    const editor = rolePermissionSet("editor", true, [{ permission: "draft.approve", allowed: false }, { permission: "users.manage", allowed: true }]);
    expect(editor.has("draft.approve")).toBe(false);
    expect(editor.has("users.manage")).toBe(true);
    expect(editor.has("draft.reject")).toBe(true);
    expect(rolePermissionSet("video-editor", false, []).size).toBe(0);
    expect([...rolePermissionSet("video-editor", false, [{ permission: "video.export", allowed: true }, { permission: "gone.key", allowed: true }])]).toEqual(["video.export"]);
  });

  it("never takes users.manage or roles.manage from the admin role", () => {
    const admin = rolePermissionSet("admin", true, ADMIN_ALWAYS.map((permission) => ({ permission, allowed: false })));
    for (const k of ADMIN_ALWAYS) expect(admin.has(k)).toBe(true);
  });

  it("applies a user's exceptions on top of the role", () => {
    const role = rolePermissionSet("operator", true, []);
    const eff = effectivePermissionSet(role, [{ permission: "post.publish", allowed: false }, { permission: "trends.refresh", allowed: true }, { permission: "nope", allowed: true }]);
    expect(eff.has("post.publish")).toBe(false);
    expect(eff.has("trends.refresh")).toBe(true);
    expect(eff.has("draft.edit")).toBe(true);
    expect(role.has("post.publish")).toBe(true);
  });
});

describe("roleKeyFromLabel", () => {
  it("slugs the label", () => {
    expect(roleKeyFromLabel("Video Editor")).toBe("video-editor");
    expect(roleKeyFromLabel("  Desk -- Night shift (2) ")).toBe("desk-night-shift-2");
    expect(roleKeyFromLabel("Café Rédacteur")).toBe("cafe-redacteur");
    expect(roleKeyFromLabel("वीडियो")).toBe("");
    expect(roleKeyFromLabel("a".repeat(39) + " b")).toBe("a".repeat(39));
  });
});
