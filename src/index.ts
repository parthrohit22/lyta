import { router } from "./router";
import { Conversation } from "./durable/conversation";

export interface Env {
  AI: any;
  CONVERSATION: DurableObjectNamespace;
}


export default {
  fetch(request: Request, env: Env) {
    return router(request, env);
  },
};

export { Conversation };