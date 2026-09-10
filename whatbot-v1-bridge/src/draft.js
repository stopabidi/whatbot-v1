const TEMPLATES = {
  unknown_user: (ctx) => `Hello! I don't recognize this number. Please share this code with the admin so they can add you:\n\n*${ctx.code}*\n\nOnce approved, you can ask questions about the research.`,
  rate_limited: () => "You're sending messages too quickly. Please wait a moment.",
  error: () => "I'm sorry, I encountered an error processing your question. Please try again.",
  file_not_found: (ctx) => `I couldn't find a document matching "${ctx.name}". Could you tell me more about which document you're looking for? For example, is it about pricing, strategy, exit planning, or something else?`,
  no_documents: () => 'No documents are currently available.',
  file_offer_confused: () => "I'm not sure which paper you're referring to. Could you specify the document name?",
};

export async function draftMessage(kind, context = {}) {
  const template = TEMPLATES[kind];
  if (!template) return `[${kind}]`;
  return template(context);
}
