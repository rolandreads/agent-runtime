declare const brand: unique symbol;

type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export type UserId = Brand<string, 'UserId'>;
export type ComfyPromptId = Brand<string, 'ComfyPromptId'>;
export type ConversationId = Brand<number, 'ConversationId'>;
export type FrontendUserId = Brand<string, 'FrontendUserId'>;
export type ImageRequestId = Brand<number, 'ImageRequestId'>;
export type ComputeWorkerId = Brand<number, 'ComputeWorkerId'>;
export type GeneratedImageId = Brand<number, 'GeneratedImageId'>;
export type AnimateRequestId = Brand<number, 'AnimateRequestId'>;
