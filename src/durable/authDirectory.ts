import {
  createId,
  createPasswordRecord,
  createSessionToken,
  hashToken,
  verifyPassword
} from "../auth/crypto"

interface AuthUserRecord {
  id: string
  email: string
  passwordHash: string
  passwordSalt: string
  createdAt: string
}

interface AuthSessionRecord {
  userId: string
  email: string
  createdAt: string
  expiresAt: string
}

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30

export class AuthDirectory {

  state: DurableObjectState
  private lock: Promise<void> = Promise.resolve()

  constructor(state: DurableObjectState){
    this.state = state
  }

  async fetch(request: Request): Promise<Response>{
    const path = new URL(request.url).pathname

    if (path === "/register" && request.method === "POST") {
      return this.guard(() => this.queue(() => this.register(request)))
    }

    if (path === "/login" && request.method === "POST") {
      return this.guard(() => this.queue(() => this.login(request)))
    }

    if (path === "/session" && request.method === "POST") {
      return this.guard(() => this.validateSession(request))
    }

    if (path === "/logout" && request.method === "POST") {
      return this.guard(() => this.queue(() => this.logout(request)))
    }

    return new Response("Not Found", { status: 404 })
  }

  private async queue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn)
    this.lock = next.then(() => {}, () => {})
    return next
  }

  private async guard(fn: () => Promise<Response>) {
    try {
      return await fn()
    } catch (error) {
      console.error("AuthDirectory failure", error)
      return new Response("Authentication service failed", {
        status: 500
      })
    }
  }

  private async register(request: Request) {
    const body = await request.json() as {
      email?: string
      password?: string
    }

    const email = normalizeEmail(body.email)
    const password = typeof body.password === "string"
      ? body.password
      : ""

    if (!email) {
      return new Response("Email is required", { status: 400 })
    }

    if (!isValidEmail(email)) {
      return new Response("Enter a valid email address", { status: 400 })
    }

    if (password.length < 8) {
      return new Response(
        "Password must be at least 8 characters",
        { status: 400 }
      )
    }

    const usersByEmail =
      (await this.state.storage.get<Record<string, AuthUserRecord>>("usersByEmail")) || {}

    if (usersByEmail[email]) {
      return new Response("Account already exists", { status: 409 })
    }

    const passwordRecord =
      await createPasswordRecord(password)

    const user: AuthUserRecord = {
      id: createId("user"),
      email,
      passwordHash: passwordRecord.hash,
      passwordSalt: passwordRecord.salt,
      createdAt: new Date().toISOString()
    }

    usersByEmail[email] = user

    await this.state.storage.put("usersByEmail", usersByEmail)

    const authSession = await this.createSession(user)

    return Response.json({
      token: authSession.token,
      user: {
        id: user.id,
        email: user.email
      }
    })
  }

  private async login(request: Request) {
    const body = await request.json() as {
      email?: string
      password?: string
    }

    const email = normalizeEmail(body.email)
    const password = typeof body.password === "string"
      ? body.password
      : ""

    if (!email || !password) {
      return new Response("Email and password are required", {
        status: 400
      })
    }

    const usersByEmail =
      (await this.state.storage.get<Record<string, AuthUserRecord>>("usersByEmail")) || {}

    const user = usersByEmail[email]

    if (!user) {
      return new Response("Invalid email or password", { status: 401 })
    }

    const valid = await verifyPassword(password, {
      hash: user.passwordHash,
      salt: user.passwordSalt
    })

    if (!valid) {
      return new Response("Invalid email or password", { status: 401 })
    }

    const authSession = await this.createSession(user)

    return Response.json({
      token: authSession.token,
      user: {
        id: user.id,
        email: user.email
      }
    })
  }

  private async validateSession(request: Request) {
    const body = await request.json() as {
      token?: string
    }

    if (!body?.token) {
      return new Response("Token required", { status: 400 })
    }

    const tokenHash = await hashToken(body.token)
    const sessions =
      (await this.state.storage.get<Record<string, AuthSessionRecord>>("sessions")) || {}

    const session = sessions[tokenHash]

    if (!session) {
      return new Response("Unauthorized", { status: 401 })
    }

    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      delete sessions[tokenHash]
      await this.state.storage.put("sessions", sessions)
      return new Response("Unauthorized", { status: 401 })
    }

    return Response.json({
      user: {
        id: session.userId,
        email: session.email
      }
    })
  }

  private async logout(request: Request) {
    const body = await request.json() as {
      token?: string
    }

    if (!body?.token) {
      return Response.json({ ok: true })
    }

    const tokenHash = await hashToken(body.token)
    const sessions =
      (await this.state.storage.get<Record<string, AuthSessionRecord>>("sessions")) || {}

    delete sessions[tokenHash]
    await this.state.storage.put("sessions", sessions)

    return Response.json({ ok: true })
  }

  private async createSession(user: AuthUserRecord) {
    const token = createSessionToken()
    const tokenHash = await hashToken(token)
    const sessions =
      (await this.state.storage.get<Record<string, AuthSessionRecord>>("sessions")) || {}

    const now = Date.now()

    sessions[tokenHash] = {
      userId: user.id,
      email: user.email,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString()
    }

    await this.state.storage.put("sessions", sessions)

    return {
      token
    }
  }
}

function normalizeEmail(value: string | undefined) {
  if (typeof value !== "string") {
    return ""
  }

  return value.trim().toLowerCase()
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}
