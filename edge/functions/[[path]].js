// Every path goes to the Worker unchanged: same URL (so cookies, redirects and PUBLIC_ORIGIN links
// use this host), same headers (CF-Connecting-IP still reaches the login throttle), same body.
export const onRequest = ({ request, env }) => env.APP.fetch(request);
