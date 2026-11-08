import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  route("login", "routes/login.tsx"),
  route("logout", "routes/logout.tsx"),
  route("img/*", "routes/img.ts"),
  layout("routes/owner-layout.tsx", [
    index("routes/home.tsx"),
    route("settings", "routes/settings.tsx"),
    route("posts/new", "routes/post-new.tsx"),
  ]),
] satisfies RouteConfig;
