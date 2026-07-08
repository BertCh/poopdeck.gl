import type { EntryContext } from "react-router";
import { ServerRouter } from "react-router";
import { renderToReadableStream } from "react-dom/server";

/**
 * Server entry — used ONLY at build time by the prerender pass (the app ships
 * as an SPA, `ssr: false`). Providing it explicitly also pins the render path
 * so React Router doesn't have to auto-detect a server runtime (which trips
 * over pnpm's store layout).
 *
 * `await stream.allReady` forces a complete render before we hand back the
 * Response, so each prerendered route emits fully-formed static HTML rather
 * than a streamed shell.
 */
export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
): Promise<Response> {
  let statusCode = responseStatusCode;
  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      signal: request.signal,
      onError(error: unknown) {
        statusCode = 500;
        console.error(error);
      },
    },
  );

  await body.allReady;

  responseHeaders.set("Content-Type", "text/html");
  return new Response(body, {
    headers: responseHeaders,
    status: statusCode,
  });
}
