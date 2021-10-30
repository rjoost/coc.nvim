local M = {}

function M.get(cp)
	return {
		markdownHeadingDelimiter = { fg = cp.catppuccino7, style = "bold" },
		markdownCode = { fg = cp.catppuccino3 },
		markdownCodeBlock = { fg = cp.catppuccino3 },
		markdownH1 = { fg = cp.catppuccino5, style = "bold" },
		markdownH2 = { fg = cp.catppuccino10, style = "bold" },
		markdownLinkText = { fg = cp.catppuccino10, style = "underline" },
	}
end

return M