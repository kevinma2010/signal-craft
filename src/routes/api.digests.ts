import { createFileRoute } from "@tanstack/react-router";
import { handleReaderApi } from "../reader/api.server";

export const Route = createFileRoute("/api/digests")({
  server: {
    handlers: {
      GET: ({ request }) => handleReaderApi(request),
      HEAD: ({ request }) => handleReaderApi(request),
    },
  },
});
