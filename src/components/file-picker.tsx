import { useRef } from "react"
import { Upload } from "lucide-react"
import { Button } from "@/components/ui/button"

/** Upload button over a hidden file input; the input is cleared after each pick so the same file can be sent again. */
export function FilePicker({
  label,
  accept,
  disabled,
  onFile,
}: {
  label: string
  accept: string
  disabled: boolean
  onFile: (file: File) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={accept}
        className="sr-only"
        aria-label={label}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onFile(file)
          e.target.value = ""
        }}
      />
      <Button variant="outline" disabled={disabled} onClick={() => input.current?.click()}>
        <Upload />
        {label}
      </Button>
    </>
  )
}
