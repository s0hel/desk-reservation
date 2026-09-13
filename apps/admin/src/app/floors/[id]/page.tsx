import { notFound, redirect } from "next/navigation";

import { Editor } from "@/components/editor/Editor";
import { apiJson } from "@/lib/api";
import { getAccessToken, getIdentity, isAdmin } from "@/lib/session";
import { ProblemError, type FloorEditorData } from "@/lib/types";

/**
 * Loads the floor on the server and hands it to the client editor.
 *
 * One round trip: `GET /v1/admin/floors/{id}` returns the floor, the site, the plan,
 * the layout (draft if there is one) and the groups together, because a CAD-ish editor
 * that renders in four waterfalling stages feels broken before it has done anything.
 */
export default async function FloorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = await getAccessToken();
  const identity = await getIdentity();
  if (!token || !isAdmin(identity)) redirect("/sign-in");

  let data: FloorEditorData;
  try {
    data = await apiJson<FloorEditorData>(`/v1/admin/floors/${id}`, { token });
  } catch (error) {
    if (error instanceof ProblemError && error.status === 404) notFound();
    throw error;
  }

  // The plan URL is signed and short-lived (TDD §11), so it is minted per render rather
  // than cached — a URL baked into a build would expire mid-session.
  return <Editor initial={data} />;
}
