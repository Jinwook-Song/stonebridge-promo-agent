import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  route("login", "routes/login.tsx"),
  route("logout", "routes/logout.tsx"),
  route("img/*", "routes/img.ts"),
  layout("routes/owner-layout.tsx", [
    index("routes/posts.tsx"),
    route("posts/new", "routes/post-new.tsx"),
    route("posts/:id", "routes/post-detail.tsx"),
    route("api/posts/:id/status", "routes/api.post-status.ts"),
    route("settings", "routes/settings.tsx"),
  ]),
] satisfies RouteConfig;
