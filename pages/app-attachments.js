window.LytaAttachments = (() => {
  const { toSingleLine } = window.LytaCore

  const MAX_DOCUMENT_TEXT = 12000
  const MAX_SUMMARY_LENGTH = 180
  const MAX_IMAGE_PAYLOAD_BYTES = 900000
  const PDF_MIME = "application/pdf"
  const DOCX_MIME =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  const TEXT_FILE_EXTENSIONS = new Set([
    "txt",
    "md",
    "csv",
    "json",
    "html",
    "htm",
    "xml"
  ])

  async function prepareAttachment(file) {
    const mimeType = inferMimeType(file)
    const extension = getFileExtension(file.name)

    if (mimeType.startsWith("image/")) {
      return prepareImageAttachment(file, mimeType)
    }

    if (mimeType === PDF_MIME || extension === "pdf") {
      return preparePdfAttachment(file, mimeType || PDF_MIME)
    }

    if (mimeType === DOCX_MIME || extension === "docx") {
      return prepareDocxAttachment(file, mimeType || DOCX_MIME)
    }

    if (
      mimeType.startsWith("text/") ||
      mimeType === "application/json" ||
      mimeType === "application/xml" ||
      TEXT_FILE_EXTENSIONS.has(extension)
    ) {
      return prepareTextAttachment(file, mimeType || "text/plain")
    }

    throw new Error(
      "Use images, PDF, DOCX, TXT, MD, CSV, JSON, HTML, or XML files."
    )
  }

  async function prepareTextAttachment(file, mimeType) {
    const extractedText = cleanDocumentText(await file.text())

    if (!extractedText) {
      throw new Error("This document did not contain readable text.")
    }

    return buildDocumentAttachment(file, mimeType, extractedText, "Text")
  }

  async function preparePdfAttachment(file, mimeType) {
    if (!window.pdfjsLib?.getDocument) {
      throw new Error("PDF tools are still loading. Try again in a moment.")
    }

    const pdf = await window.pdfjsLib.getDocument({
      data: await file.arrayBuffer()
    }).promise

    let extractedText = ""
    const pageLimit = Math.min(pdf.numPages, 8)

    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent()
      extractedText += content.items.map(item => item.str || "").join(" ") + "\n\n"

      if (extractedText.length >= MAX_DOCUMENT_TEXT * 1.2) {
        break
      }
    }

    extractedText = cleanDocumentText(extractedText)

    if (!extractedText) {
      throw new Error(
        "This PDF did not expose readable text. Try a text-based PDF or paste excerpts."
      )
    }

    return buildDocumentAttachment(
      file,
      mimeType,
      extractedText,
      "PDF",
      `${pdf.numPages} page${pdf.numPages === 1 ? "" : "s"}`
    )
  }

  async function prepareDocxAttachment(file, mimeType) {
    if (!window.mammoth?.extractRawText) {
      throw new Error("DOCX tools are still loading. Try again in a moment.")
    }

    const result = await window.mammoth.extractRawText({
      arrayBuffer: await file.arrayBuffer()
    })

    const extractedText = cleanDocumentText(result.value)

    if (!extractedText) {
      throw new Error("This DOCX file did not contain readable text.")
    }

    return buildDocumentAttachment(file, mimeType, extractedText, "DOCX")
  }

  function buildDocumentAttachment(
    file,
    mimeType,
    extractedText,
    kindLabel,
    detail = ""
  ) {
    const summary = [kindLabel, detail, toSingleLine(extractedText, 110)]
      .filter(Boolean)
      .join(" • ")
      .slice(0, MAX_SUMMARY_LENGTH)

    return {
      id: crypto.randomUUID(),
      libraryFileId: "",
      kind: "document",
      name: file.name,
      mimeType,
      size: file.size,
      summary,
      extractedText
    }
  }

  async function prepareImageAttachment(file, mimeType) {
    const image = await loadImageElement(file)

    let maxSide = 1600
    let outputType = mimeType === "image/png" ? "image/png" : "image/jpeg"
    let quality = outputType === "image/png" ? undefined : 0.88
    let width = image.naturalWidth
    let height = image.naturalHeight
    let blob = null

    while (true) {
      const scale = Math.min(
        1,
        maxSide / Math.max(image.naturalWidth, image.naturalHeight)
      )

      width = Math.max(1, Math.round(image.naturalWidth * scale))
      height = Math.max(1, Math.round(image.naturalHeight * scale))

      const canvas = document.createElement("canvas")
      canvas.width = width
      canvas.height = height

      const context = canvas.getContext("2d")

      if (!context) {
        throw new Error("Your browser could not prepare this image.")
      }

      context.drawImage(image, 0, 0, width, height)
      blob = await canvasToBlob(canvas, outputType, quality)

      if (!blob) {
        throw new Error("Unable to convert this image.")
      }

      if (
        blob.size <= MAX_IMAGE_PAYLOAD_BYTES ||
        (maxSide <= 900 && (quality == null || quality <= 0.74))
      ) {
        break
      }

      if (outputType === "image/png") {
        outputType = "image/jpeg"
        quality = 0.84
        continue
      }

      if (quality && quality > 0.74) {
        quality -= 0.08
        continue
      }

      maxSide = Math.round(maxSide * 0.84)
    }

    const dataUrl = await blobToDataUrl(blob)

    return {
      id: crypto.randomUUID(),
      libraryFileId: "",
      kind: "image",
      name: file.name,
      mimeType: blob.type || outputType,
      size: blob.size,
      summary: `${width} x ${height} image`,
      dataUrl
    }
  }

  function inferMimeType(file) {
    if (file.type) {
      return file.type
    }

    const extension = getFileExtension(file.name)
    const map = {
      pdf: PDF_MIME,
      docx: DOCX_MIME,
      txt: "text/plain",
      md: "text/markdown",
      csv: "text/csv",
      json: "application/json",
      html: "text/html",
      htm: "text/html",
      xml: "application/xml"
    }

    return map[extension] || "application/octet-stream"
  }

  function getFileExtension(name) {
    return name.split(".").pop()?.toLowerCase() || ""
  }

  function cleanDocumentText(text) {
    return (text || "")
      .replace(/\u0000/g, " ")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, MAX_DOCUMENT_TEXT)
  }

  async function loadImageElement(file) {
    const objectUrl = URL.createObjectURL(file)

    try {
      return await new Promise((resolve, reject) => {
        const image = new Image()
        image.onload = () => resolve(image)
        image.onerror = () => reject(new Error("Unable to read this image."))
        image.src = objectUrl
      })
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(resolve => {
      canvas.toBlob(resolve, type, quality)
    })
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(new Error("Unable to preview this image."))
      reader.readAsDataURL(blob)
    })
  }

  return { prepareAttachment }
})()
