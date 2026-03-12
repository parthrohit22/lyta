const MODEL = "@cf/meta/llama-3-8b-instruct";

export async function runAI(env: any, messages: any[]) {
  return env.AI.run(MODEL, {
    messages,
  });
}

export async function runAIStream(env: any, messages: any[]) {
  return env.AI.run(MODEL, {
    messages,
    stream: true,
  });
}