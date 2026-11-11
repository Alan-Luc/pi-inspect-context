package inspectcontext

import (
	"path/filepath"
	"regexp"
	"strings"
)

const maxExpandedEvidenceBodies = 3

var declarationBodyPrefix = regexp.MustCompile(`^(?:(?:export|default|declare|abstract|async|public|private|protected|static|final)\s+)*(function|class|interface|enum|type)\s+`)
var arrowBodyPrefix = regexp.MustCompile(`^(?:export\s+)?(?:const|let|var)\s+[^=;]+\s*=\s*(?:async\s+)?(?:\([^;{}]*\)|[a-z_$][\w$]*)\s*(?::[^=;{}]+)?=>`)
var arrowHeaderStart = regexp.MustCompile(`^(?:export\s+)?(?:const|let|var)\s+[^=;]+\s*=\s*(?:async\s*)?\([^);{}]*$`)

type sourceBodyRange struct {
	startLine, endLine        int
	complete, found, enclosed bool
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
	if extension != ".go" && strings.Contains(strings.TrimRight(line, "\r\n"), "\r") || javascriptPath(extension) && strings.ContainsAny(line, "\u2028\u2029") || extension == ".java" && strings.Contains(line, `\u`) {
		state.uncertain = true
	}
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
			// shortcut: Python f-strings and t-strings stay partial, add tokenization when their complete bodies are needed.
			if extension == ".py" && index > 0 {
				prefix := strings.ToLower(line[maxInt(0, index-2):index])
				if strings.HasSuffix(prefix, "f") || strings.HasSuffix(prefix, "fr") || strings.HasSuffix(prefix, "t") || strings.HasSuffix(prefix, "tr") {
					state.uncertain = true
				}
			}
			state.quote = string(character)
			if (extension == ".py" || extension == ".java") && strings.HasPrefix(rest, strings.Repeat(state.quote, 3)) {
				state.quote = strings.Repeat(state.quote, 3)
			}
			code.WriteByte('x')
			index += len(state.quote)
			continue
		}
		if javascriptPath(extension) && (character == '/' || character == '<' || character == '>' && (index == 0 || line[index-1] != '=')) {
			state.uncertain = true
		}
		code.WriteByte(character)
		index++
	}
	if javascriptPath(extension) && (state.quote == "'" || state.quote == "\"") {
		state.uncertain = true
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
		if declarationBodyPrefix.MatchString(trimmed) || arrowBodyPrefix.MatchString(trimmed) || arrowHeaderStart.MatchString(trimmed) {
			return true
		}
		extension = ".ts"
	} else if extension == ".java" {
		if declarationBodyPrefix.MatchString(trimmed) {
			return true
		}
	} else {
		return false
	}
	match := memberDefinitionPatterns[extension].FindStringSubmatch(trimmed)
	if len(match) < 2 {
		return false
	}
	for _, word := range []string{strings.Fields(trimmed)[0], match[1]} {
		switch word {
		case "if", "for", "while", "switch", "catch", "with", "else", "do", "new", "return", "throw", "yield", "assert":
			return false
		}
	}
	return true
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
	if javascriptPath(extension) {
		// shortcut: non-callable declarations stay partial, add syntax parsing when their complete bodies are needed.
		declaration := declarationBodyPrefix.FindStringSubmatch(strings.ToLower(strings.TrimSpace(file.lines[startLine-1])))
		if len(declaration) > 1 && declaration[1] != "function" {
			return sourceBodyRange{}
		}
	}
	state := bodyLexState{}
	var header strings.Builder
	round, square, headerBraces, bodyBraces := 0, 0, 0, 0
	parametersEnd := 0
	for number := startLine; number <= result.endLine; number++ {
		code := bodyCodeLine(file.lines[number-1], extension, &state)
		if state.uncertain {
			return result
		}
		for _, character := range code {
			if bodyBraces > 0 {
				if character == '{' {
					bodyBraces++
				} else if character == '}' {
					bodyBraces--
					if bodyBraces == 0 {
						result.endLine = number
						result.enclosed = true
						result.complete = !state.uncertain && state.quote == "" && !state.blockComment
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
				if javascriptPath(extension) && round == 0 && parametersEnd == 0 {
					parametersEnd = header.Len() + 1
				}
			case '[':
				square++
			case ']':
				square--
			case '{':
				if round == 0 && square == 0 && headerBraces == 0 && bodyHeader(header.String()+"{", extension) {
					prefix := strings.ToLower(header.String())
					returns := prefix[strings.LastIndex(prefix, ")")+1:]
					if extension == ".go" && strings.HasPrefix(strings.TrimSpace(prefix), "func ") && (strings.Contains(returns, "struct") || strings.Contains(returns, "interface")) {
						return result
					}
					if javascriptPath(extension) {
						ambiguousType := parametersEnd > 0 && strings.Contains(header.String()[parametersEnd:], ":") || strings.Count(prefix, "<") > strings.Count(prefix, ">")
						ambiguousArrow := strings.Count(prefix, "=>") > 1 || strings.Contains(prefix, "=>") && (!arrowBodyPrefix.MatchString(prefix) || !strings.HasSuffix(strings.TrimSpace(prefix), "=>"))
						if ambiguousArrow || ambiguousType {
							return result
						}
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
					result.enclosed = true
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
		if state.uncertain {
			return result
		}
		if headerEnded && !continuation && strings.TrimSpace(code) != "" && pythonIndent(line) <= indent {
			result.endLine = number - 1
			result.enclosed = true
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
	result.enclosed = result.endLine == len(file.lines) && headerEnded && sawBody && depth == 0 && !continued
	result.complete = result.enclosed && state.quote == "" && !state.uncertain
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
		if body.found && (kind != "caller" || body.enclosed && body.endLine >= last) {
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
