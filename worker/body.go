package inspectcontext

import (
	"path/filepath"
	"regexp"
	"strings"
)

const maxExpandedEvidenceBodies = 3

var declarationBodyPrefix = regexp.MustCompile(`^(?:(?:export|default|declare|abstract|async|public|private|protected|static|final)\s+)*(?:function|class|interface|enum|type)\s+`)
var arrowBodyPrefix = regexp.MustCompile(`^(?:export\s+)?(?:const|let|var)\s+[^=;]+\s*=\s*(?:async\s+)?(?:\([^;{}]*\)|[a-z_$][\w$]*)\s*(?::[^=;{}]+)?=>`)
var arrowHeaderStart = regexp.MustCompile(`^(?:export\s+)?(?:const|let|var)\s+[^=;]+\s*=\s*(?:async\s*)?\([^);{}]*$`)

type sourceBodyRange struct {
	startLine, endLine int
	complete, found    bool
}

type bodyLexState struct {
	quote        string
	blockComment bool
	uncertain    bool
}

func javascriptPath(extension string) bool {
	return extension == ".ts" || extension == ".tsx" || extension == ".js" || extension == ".jsx"
}

func bodyCodeLine(line, extension string, state *bodyLexState) string {
	var code strings.Builder
	for index := 0; index < len(line); {
		rest := line[index:]
		if state.blockComment {
			if strings.HasPrefix(rest, "*/") {
				state.blockComment = false
				index += 2
			} else {
				index++
			}
			continue
		}
		if state.quote != "" {
			if javascriptPath(extension) && state.quote == "`" && strings.HasPrefix(rest, "${") {
				state.uncertain = true
			}
			if line[index] == '\\' && !(extension == ".go" && state.quote == "`") {
				index += 2
			} else if strings.HasPrefix(rest, state.quote) {
				index += len(state.quote)
				state.quote = ""
			} else {
				index++
			}
			continue
		}
		if extension == ".py" && line[index] == '#' || extension != ".py" && strings.HasPrefix(rest, "//") {
			break
		}
		if extension != ".py" && strings.HasPrefix(rest, "/*") {
			state.blockComment = true
			code.WriteByte(' ')
			index += 2
			continue
		}
		character := line[index]
		if character == '\'' || character == '"' || character == '`' {
			state.quote = string(character)
			if (extension == ".py" || extension == ".java") && strings.HasPrefix(rest, strings.Repeat(state.quote, 3)) {
				state.quote = strings.Repeat(state.quote, 3)
			}
			code.WriteByte('x')
			index += len(state.quote)
			continue
		}
		if javascriptPath(extension) && character == '/' {
			state.uncertain = true
		}
		code.WriteByte(character)
		index++
	}
	return code.String()
}

func bodyHeader(line, extension string) bool {
	trimmed := strings.ToLower(strings.TrimSpace(line))
	if extension == ".py" {
		return strings.HasPrefix(trimmed, "def ") || strings.HasPrefix(trimmed, "async def ") || strings.HasPrefix(trimmed, "class ")
	}
	if extension == ".go" {
		return strings.HasPrefix(trimmed, "func ") || strings.HasPrefix(trimmed, "type ")
	}
	if javascriptPath(extension) {
		return declarationBodyPrefix.MatchString(trimmed) || arrowBodyPrefix.MatchString(trimmed) || arrowHeaderStart.MatchString(trimmed) || memberDefinitionPatterns[".ts"].MatchString(trimmed)
	}
	if extension == ".java" {
		return declarationBodyPrefix.MatchString(trimmed) || memberDefinitionPatterns[".java"].MatchString(trimmed)
	}
	return false
}

func sourceBody(file retrievalFile, startLine int) sourceBodyRange {
	extension := strings.ToLower(filepath.Ext(file.path))
	if !bodyHeader(file.lines[startLine-1], extension) {
		return sourceBodyRange{}
	}
	if extension == ".py" {
		return pythonBody(file, startLine)
	}
	result := sourceBodyRange{startLine: startLine, endLine: minInt(len(file.lines), startLine+maxExcerptLines-1), found: true}
	state := bodyLexState{}
	var header strings.Builder
	round, square, headerBraces, bodyBraces := 0, 0, 0, 0
	for number := startLine; number <= result.endLine; number++ {
		code := bodyCodeLine(file.lines[number-1], extension, &state)
		for _, character := range code {
			if bodyBraces > 0 {
				if character == '{' {
					bodyBraces++
				} else if character == '}' {
					bodyBraces--
					if bodyBraces == 0 {
						if state.uncertain {
							return result
						}
						result.endLine = number
						result.complete = state.quote == "" && !state.blockComment
						return result
					}
				}
				continue
			}
			switch character {
			case '(':
				round++
			case ')':
				round--
			case '[':
				square++
			case ']':
				square--
			case '{':
				if round == 0 && square == 0 && headerBraces == 0 && bodyHeader(header.String()+"{", extension) {
					prefix := strings.ToLower(header.String())
					returns := prefix[strings.LastIndex(prefix, ")")+1:]
					if extension == ".go" && strings.HasPrefix(strings.TrimSpace(prefix), "func ") && (strings.Contains(returns, "struct") || strings.Contains(returns, "interface")) || javascriptPath(extension) && strings.HasSuffix(strings.TrimSpace(prefix), ":") {
						return result
					}
					bodyBraces = 1
				} else {
					headerBraces++
				}
			case '}':
				headerBraces--
			case ';':
				if round == 0 && square == 0 && headerBraces == 0 {
					if !arrowBodyPrefix.MatchString(strings.ToLower(header.String())) {
						return sourceBodyRange{}
					}
					result.endLine = number
					result.complete = state.quote == "" && !state.blockComment && !state.uncertain
					return result
				}
			}
			header.WriteRune(character)
		}
		header.WriteByte(' ')
	}
	return result
}

func pythonIndent(line string) int {
	indent := 0
	for _, character := range line {
		if character == ' ' {
			indent++
		} else if character == '\t' {
			indent = (indent/8 + 1) * 8
		} else if character == '\f' {
			indent = 0
		} else {
			break
		}
	}
	return indent
}

func pythonBody(file retrievalFile, startLine int) sourceBodyRange {
	result := sourceBodyRange{startLine: startLine, endLine: minInt(len(file.lines), startLine+maxExcerptLines-1), found: true}
	state := bodyLexState{}
	indent := pythonIndent(file.lines[startLine-1])
	depth := 0
	headerEnded, sawBody, continued := false, false, false
	for number := startLine; number <= minInt(len(file.lines), result.endLine+1); number++ {
		continuation := state.quote != "" || depth > 0 || continued
		line := file.lines[number-1]
		code := bodyCodeLine(line, ".py", &state)
		if headerEnded && !continuation && strings.TrimSpace(code) != "" && pythonIndent(line) <= indent {
			result.endLine = number - 1
			result.complete = sawBody && state.quote == "" && !state.uncertain
			return result
		}
		if number > result.endLine {
			return result
		}
		continued = strings.HasSuffix(strings.TrimSpace(code), "\\")
		if headerEnded && strings.TrimSpace(code) != "" {
			sawBody = true
		}
		for index, character := range code {
			switch character {
			case '(', '[', '{':
				depth++
			case ')', ']', '}':
				depth--
			case ':':
				if !headerEnded && depth == 0 {
					headerEnded = true
					if strings.TrimSpace(code[index+1:]) != "" {
						sawBody = true
						state.uncertain = true
					}
				}
			}
		}
	}
	result.complete = result.endLine == len(file.lines) && headerEnded && sawBody && depth == 0 && state.quote == "" && !state.uncertain && !continued
	return result
}

func prepareEvidenceWindow(file retrievalFile, window retrievalWindow, kind string, terms []searchTerm, expandedBodies *int) retrievalWindow {
	first, last := window.candidates[0].startLine, window.candidates[0].endLine
	anchor := first
	for _, candidate := range window.candidates {
		first = minInt(first, candidate.startLine)
		last = maxInt(last, candidate.endLine)
		for _, category := range classifyRetrievedCandidate(candidate.path, file.lines[candidate.startLine-1], candidate, terms) {
			if category.kind == kind {
				anchor = candidate.startLine
			}
		}
	}
	radius := 0
	switch kind {
	case "governing":
		return window
	case "definition", "caller":
		radius = 2
	case "test", "configuration":
		radius = 1
	}
	window.startLine = maxInt(1, first-radius)
	window.endLine = minInt(len(file.lines), last+radius)
	if window.endLine-window.startLine+1 > maxExcerptLines {
		window.endLine = maxInt(last, window.startLine+maxExcerptLines-1)
		window.startLine = maxInt(1, window.endLine-maxExcerptLines+1)
	}
	if kind != "definition" && kind != "caller" || *expandedBodies >= maxExpandedEvidenceBodies {
		return window
	}
	for start := anchor; start >= maxInt(1, anchor-maxExcerptLines+1); start-- {
		body := sourceBody(file, start)
		if body.found && (kind != "caller" || body.endLine >= last) {
			begin, end := minInt(body.startLine, first), maxInt(body.endLine, last)
			if end-begin+1 <= maxExcerptLines {
				window.startLine, window.endLine = begin, end
				window.bodyComplete = body.complete && begin == body.startLine && end == body.endLine
				(*expandedBodies)++
				return window
			}
		}
		if kind == "definition" {
			break
		}
	}
	return window
}
