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
    route("api/photo-pick", "routes/api.photo-pick.ts"),
    route("quotes", "routes/quotes.tsx"),
    route("quotes/new", "routes/quote-new.tsx"),
    route("quotes/:id", "routes/quote-detail.tsx"),
    route("quotes/:id/v/:version/xlsx", "routes/quote-xlsx.ts"),
    route("api/quotes/:id/status", "routes/api.quote-status.ts"),
    route("settings", "routes/settings.tsx"),
    route("settings/quote", "routes/quote-settings.tsx"),
    route("kakao/connect", "routes/kakao.connect.ts"),
    route("kakao/callback", "routes/kakao.callback.ts"),
  ]),
] satisfies RouteConfig;
