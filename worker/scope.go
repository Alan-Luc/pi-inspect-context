package inspectcontext

import (
	"fmt"
	"path"
	"strings"
)

const minimumPackageSourcePaths = 3

func nearestPackageScope(repository *openedRepository, cwd string, inventory repositoryInventory) (string, error) {
	if cwd == "" || cwd == "." {
		return ".", nil
	}
	info, err := lstatRepositoryPath(repository.root, cwd)
	if err != nil {
		return "", fmt.Errorf("inspect cwd: %w", err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("cwd %q is not a directory", cwd)
	}
	packages := make(map[string]struct{})
	for _, entry := range inventory.entries {
		if entry.excluded != "" {
			continue
		}
		switch path.Base(entry.path) {
		case "package.json", "pyproject.toml", "go.mod", "Cargo.toml", "pom.xml", "build.gradle":
			packages[path.Dir(entry.path)] = struct{}{}
		}
	}
	for directory := cwd; directory != "."; directory = path.Dir(directory) {
		if _, found := packages[directory]; found {
			return directory, nil
		}
	}
	return ".", nil
}

func inPackageScope(file, scope string) bool {
	return scope == "." || strings.HasPrefix(file, scope+"/")
}

func isPackageSourcePath(file string) bool {
	switch strings.ToLower(path.Ext(file)) {
	case ".ts", ".tsx", ".js", ".jsx", ".go", ".py", ".java":
		return true
	default:
		return false
	}
}

func scopeRetrievalFiles(files []retrievalFile, terms []searchTerm, scope string, result *scanResult) []retrievalFile {
	if scope == "." {
		return files
	}
	matchingPaths := 0
	for _, file := range files {
		if inPackageScope(file.path, scope) && isPackageSourcePath(file.path) &&
			(len(matchingSearchTerms(strings.ToLower(file.text), terms)) > 0 || len(matchingPathTerms(strings.ToLower(file.path), terms)) > 0) {
			matchingPaths++
		}
	}
	if matchingPaths < minimumPackageSourcePaths {
		result.unknowns = append(result.unknowns, fmt.Sprintf("Thin package %q: repository fallback.", scope))
		return files
	}
	result.unknowns = append(result.unknowns, fmt.Sprintf("Package %q; sibling evidence omitted.", scope))
	scoped := make([]retrievalFile, 0, len(files))
	for _, file := range files {
		directory := path.Dir(file.path)
		ancestorGoverning := governingName(file.path) && (directory == "." || strings.HasPrefix(scope, directory+"/"))
		if inPackageScope(file.path, scope) || ancestorGoverning {
			scoped = append(scoped, file)
		} else {
			result.omissions.add("package_scope", file.path)
		}
	}
	return scoped
}
