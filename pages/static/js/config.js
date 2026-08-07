export const STORAGE_KEY_CONVS = 'copilot_conversations_v3';
export const STORAGE_KEY_ACTIVE = 'copilot_active_conv_v3';
export const STORAGE_KEY_MODEL = 'copilot_chat_model_v1';
export const STORAGE_KEY_HIDDEN = 'copilot_hidden_models_v1';

export const DEFAULT_TOKEN_LIMIT = 1000000;

export const MODEL_LIMITS_DB_NAME = 'copilot_model_limits_db';
export const MODEL_LIMITS_DB_VERSION = 1;
export const MODEL_LIMITS_STORE = 'model_limits';

export const CHAT_DB_NAME = 'copilot_chats_db';
export const CHAT_DB_VERSION = 1;
export const CHAT_STORE = 'chats_store';

// Folders and their collapsed state persist inside the backend chats.json blob
// alongside conversations, so no dedicated localStorage keys are required.
