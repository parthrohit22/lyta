const chat = document.getElementById("chat")
const input = document.getElementById("message")
const typing = document.getElementById("typing")
const sessionsDiv = document.getElementById("sessions")
const newChatBtn = document.getElementById("newChat")



const savedTheme = localStorage.getItem("lyta_theme")

function toggleDark(){
  document.body.classList.toggle("dark")

  if(document.body.classList.contains("dark")){
    localStorage.setItem("lyta_theme","dark")
  }else{
    localStorage.setItem("lyta_theme","light")
  }
}

if(savedTheme === "dark"){
  document.body.classList.add("dark")
}



let sessionId = localStorage.getItem("lyta_session")

if(!sessionId){
  sessionId = crypto.randomUUID()
  localStorage.setItem("lyta_session",sessionId)
}



let sessions = JSON.parse(localStorage.getItem("lyta_sessions") || "[]")

if(!sessions.find(s => s.id === sessionId)){
  sessions.unshift({
    id: sessionId,
    name: "Chat 1"
  })

  localStorage.setItem("lyta_sessions",JSON.stringify(sessions))
}



function renderSessions(){

  sessionsDiv.innerHTML = ""

  sessions.forEach(s => {

    const div = document.createElement("div")
    div.className = "session"
    div.textContent = s.name

    if(s.id === sessionId){
      div.style.fontWeight = "bold"
    }

    div.onclick = async () => {

      sessionId = s.id
      localStorage.setItem("lyta_session",sessionId)

      renderSessions()
      await loadHistory()

    }

    sessionsDiv.appendChild(div)

  })

}

renderSessions()



if(newChatBtn){

  newChatBtn.onclick = async () => {

    const id = crypto.randomUUID()

    sessions.unshift({
      id,
      name: "Chat " + (sessions.length + 1)
    })

    localStorage.setItem("lyta_sessions",JSON.stringify(sessions))

    sessionId = id
    localStorage.setItem("lyta_session",sessionId)

    renderSessions()

    chat.innerHTML = ""

  }

}



input.addEventListener("input", () => {
  input.style.height = "auto"
  input.style.height = input.scrollHeight + "px"
})



function append(role,text){

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



function addCopyButtons(){

  document.querySelectorAll("pre").forEach(block => {

    if(block.querySelector(".copy")) return

    const btn = document.createElement("button")
    btn.textContent = "copy"
    btn.className = "copy"

    btn.onclick = () => {
      navigator.clipboard.writeText(block.innerText)
      btn.textContent = "copied"
      setTimeout(() => btn.textContent = "copy",1000)
    }

    block.appendChild(btn)

  })

}



async function send(){

  const message = input.value.trim()
  if(!message) return

  append("user",message)

  input.value = ""
  input.style.height = "auto"

  typing.style.display = "inline"

  const assistantDiv = append("assistant","")

  const response = await fetch("/chat/stream",{
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({ message })
  })

  const reader = response.body.getReader()
  const decoder = new TextDecoder()

  let buffer = ""
  let fullText = ""

  while(true){

    const {done,value} = await reader.read()
    if(done) break

    buffer += decoder.decode(value,{stream:true})

    const lines = buffer.split("\n")
    buffer = lines.pop()

    for(const line of lines){

      if(!line.startsWith("data: ")) continue
      if(line.includes("[DONE]")) continue

      try{

        const parsed = JSON.parse(line.replace("data: ",""))

        if(parsed.response){

          fullText += parsed.response

          assistantDiv.innerHTML =
            marked.parse(fullText) + "<span class='cursor'></span>"

          chat.scrollTop = chat.scrollHeight

        }

      }catch{}

    }

  }

  assistantDiv.innerHTML = marked.parse(fullText)

  addCopyButtons()

  typing.style.display = "none"

}



input.addEventListener("keydown",e => {

  if(e.key === "Enter" && !e.shiftKey){
    e.preventDefault()
    send()
  }

})



async function loadHistory(){

  const res = await fetch("/history")

  if(!res.ok) return

  const data = await res.json()

  chat.innerHTML = ""

  if(!data.messages) return

  data.messages.forEach(m=>{
    append(m.role,m.content)
  })

}



async function resetSession(){

  await fetch("/reset",{method:"POST"})

  chat.innerHTML = ""

}



loadHistory()