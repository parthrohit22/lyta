const chat = document.getElementById("chat")
const input = document.getElementById("message")
const typing = document.getElementById("typing")
const sessionsDiv = document.getElementById("sessions")
const newChatBtn = document.getElementById("newChat")

let sessionId = localStorage.getItem("lyta_session")

if(!sessionId){
  sessionId = crypto.randomUUID()
  localStorage.setItem("lyta_session", sessionId)
}

let sessions =
  JSON.parse(localStorage.getItem("lyta_sessions") || "[]")

if(!sessions.length){
  sessions.push({
    id: sessionId,
    name: "Chat 1"
  })
  localStorage.setItem("lyta_sessions", JSON.stringify(sessions))
}

function saveSessions(){
  localStorage.setItem("lyta_sessions", JSON.stringify(sessions))
}

function renderSessions(){

  sessionsDiv.innerHTML = ""

  sessions.forEach(s => {

    const div = document.createElement("div")
    div.className = "session"

    const title = document.createElement("span")
    title.textContent = s.name

    if(s.id === sessionId){
      title.style.fontWeight = "bold"
    }

    const del = document.createElement("button")
    del.textContent = "×"

    del.onclick = (e)=>{
      e.stopPropagation()
      deleteChat(s.id)
    }

    div.appendChild(title)
    div.appendChild(del)

    div.onclick = async ()=>{

      sessionId = s.id
      localStorage.setItem("lyta_session", sessionId)

      renderSessions()

      await loadHistory()

    }

    sessionsDiv.appendChild(div)

  })

}

async function refreshTitles(){

  await Promise.all(
    sessions.map(async s => {

      const res = await fetch("/meta?session=" + s.id)

      if(res.ok){

        const data = await res.json()

        if(data.title){
          s.name = data.title
        }

      }

    })
  )

  saveSessions()

}

newChatBtn.onclick = async ()=>{

  const id = crypto.randomUUID()

  sessions.unshift({
    id,
    name: "New Chat"
  })

  saveSessions()

  sessionId = id
  localStorage.setItem("lyta_session", sessionId)

  renderSessions()

  chat.innerHTML = ""

}

async function deleteChat(id){

  await fetch("/reset?session=" + id, { method:"POST" })

  sessions = sessions.filter(s => s.id !== id)

  if(sessionId === id){

    if(sessions.length){
      sessionId = sessions[0].id
    }else{

      sessionId = crypto.randomUUID()

      sessions.push({
        id: sessionId,
        name: "New Chat"
      })

    }

    localStorage.setItem("lyta_session", sessionId)

  }

  saveSessions()

  renderSessions()

  await loadHistory()

}

function append(role, text){

  const div = document.createElement("div")
  div.className = "message " + role

  if(role === "assistant"){
    div.innerHTML = marked.parse(text)
  }else{
    div.textContent = text
  }

  chat.appendChild(div)

  chat.scrollTop = chat.scrollHeight

  return div

}

async function send(){

  const message = input.value.trim()

  if(!message) return

  append("user", message)

  input.value = ""

  typing.style.display = "inline"

  const assistantDiv = append("assistant", "")

  const response = await fetch(
    "/chat/stream?session=" + sessionId,
    {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({ message })
    }
  )

  const reader = response.body.getReader()
  const decoder = new TextDecoder()

  let buffer = ""
  let fullText = ""

  while(true){

    const {done, value} = await reader.read()

    if(done) break

    buffer += decoder.decode(value, {stream:true})

    const lines = buffer.split("\n")

    buffer = lines.pop()

    for(const line of lines){

      if(!line.startsWith("data: ")) continue

      if(line.includes("[DONE]")) continue

      try{

        const parsed = JSON.parse(
          line.replace("data: ","")
        )

        if(parsed.response){

          fullText += parsed.response

          assistantDiv.innerHTML =
            marked.parse(fullText)

          chat.scrollTop = chat.scrollHeight

        }

      }catch{}

    }

  }

  typing.style.display = "none"

}

input.addEventListener("keydown", e => {

  if(e.key === "Enter" && !e.shiftKey){

    e.preventDefault()

    send()

  }

})

async function loadHistory(){

  const res =
    await fetch("/history?session=" + sessionId)

  if(!res.ok) return

  const data = await res.json()

  chat.innerHTML = ""

  data.messages?.forEach(m => {

    append(m.role, m.content)

  })

}

;(async ()=>{

  await refreshTitles()

  renderSessions()

  await loadHistory()

})()