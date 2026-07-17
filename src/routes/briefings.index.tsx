import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { BookOpen } from "lucide-react";

export const Route = createFileRoute("/briefings/")({ component: Briefings });
const rootRoute = getRouteApi("__root__");

function Briefings() {
  const { digests } = rootRoute.useLoaderData();
  return (
    <section className="reader-state" role="status">
      <BookOpen aria-hidden="true" />
      <p className="digest-kind">Briefing archive</p>
      <h1 className="text-balance">
        {digests.length ? "Choose a briefing" : "No briefings yet"}
      </h1>
      <p className="text-pretty">
        {digests.length
          ? "Select a dated briefing from the archive."
          : "Generate a digest, then refresh this local reader."}
      </p>
    </section>
  );
}
