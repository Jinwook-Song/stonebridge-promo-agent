import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  route("login", "routes/login.tsx"),
  route("logout", "routes/logout.tsx"),
  layout("routes/owner-layout.tsx", [index("routes/home.tsx")]),
] satisfies RouteConfig;
