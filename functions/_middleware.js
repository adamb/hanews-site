const GA_ID_RE = /^G-[A-Z0-9]+$/;

function gaBody(env) {
  const raw = env && env.GA_MEASUREMENT_ID;
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!GA_ID_RE.test(id)) {
    return "/* GA unset */\n";
  }
  return (
    "(function(){var s=document.createElement('script');s.async=true;s.src=" +
    JSON.stringify("https://www.googletagmanager.com/gtag/js?id=" + id) +
    ";document.head.appendChild(s);})();\n" +
    "window.dataLayer = window.dataLayer || [];\n" +
    "function gtag(){dataLayer.push(arguments);}\n" +
    "gtag('js', new Date());\n" +
    "gtag('config', " +
    JSON.stringify(id) +
    ");\n"
  );
}

function gaResponse(env) {
  return new Response(gaBody(env), {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (url.pathname === "/ga.js" || url.pathname === "/ga") {
    const method = context.request.method.toUpperCase();
    if (method === "GET" || method === "HEAD") {
      return gaResponse(context.env);
    }
    return new Response("Method not allowed", { status: 405 });
  }
  return context.next();
}
