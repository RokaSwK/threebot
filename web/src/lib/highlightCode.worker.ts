import { codeLanguage, boundedCode } from "./highlightCode.shared";
import { tokenizeCode } from "./highlightCode.tokenize";

self.onmessage = async (event: MessageEvent<unknown>) => {
  const request = event.data;
  if (!request || typeof request !== "object" || !("id" in request) || typeof request.id !== "number"
    || !("source" in request) || typeof request.source !== "string" || !boundedCode(request.source)
    || !("language" in request) || typeof request.language !== "string" || !codeLanguage(request.language)) return;
  const tokens = await tokenizeCode(request.source, request.language);
  self.postMessage({ id: request.id, tokens });
};
