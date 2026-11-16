import type { Model } from "@earendil-works/pi-ai";

export interface ModelLookupRegistry {
  getAll?(): Model<any>[];
  find(provider: string, modelId: string): Model<any> | undefined;
  hasConfiguredAuth(model: Model<any>): boolean;
  isUsingOAuth(model: Model<any>): boolean;
}

export function resolveModel(
  ctx: { modelRegistry: ModelLookupRegistry },
  fullId: string,
): Model<any> | undefined {
  const separator = fullId.indexOf("/");
  const direct =
    separator <= 0 || separator === fullId.length - 1
      ? undefined
      : ctx.modelRegistry.find(
          fullId.slice(0, separator),
          fullId.slice(separator + 1),
        );
  if (direct) return direct;
  return matchListedModel(ctx, fullId);
}

function matchListedModel(
  ctx: { modelRegistry: ModelLookupRegistry },
  fullId: string,
): Model<any> | undefined {
  const models = ctx.modelRegistry.getAll?.() ?? [];
  const qualified = models.filter(
    (model) => `${model.provider}/${model.id}` === fullId,
  );
  const candidates = qualified.length
    ? qualified
    : models.filter((model) => model.id === fullId);
  if (!candidates.length) return undefined;
  const authenticated = candidates.find(
    (model) =>
      ctx.modelRegistry.hasConfiguredAuth(model) ||
      ctx.modelRegistry.isUsingOAuth(model),
  );
  return authenticated ?? candidates[0];
}
