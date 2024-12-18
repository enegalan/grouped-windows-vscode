const vscode = require('vscode');
const fs = require("fs");
const cheerio = require('cheerio');
const path = require("path");

var groups = {};
var subscriptions = [];
var activePanel;
const commandId = 'extension.openGroupManager';
const panelId = 'tabGroupManager';
const panelTitle = 'Tabs Groups Manager';
const styleId = 'grouped-tabs-style';
var styleContent = `
    
`;
var style = null;
const scriptId = 'grouped-tabs-script';
var scriptContent = `

`;
var script = null;
var htmlPath = null;
/**
 * Activate extension.
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    writeOnVsCode(scriptContent, styleContent);
    // Create a status bar item (button)
    const statusBarButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarButton.text = '$(layers) Open Tabs Groups Manager';
    statusBarButton.command = commandId;
    statusBarButton.show();
    subscriptions.push(statusBarButton);
    // Create command
    const viewColumn = vscode.ViewColumn.Beside;
    const openGroupManagerCommand = vscode.commands.registerCommand(commandId, () => {
        if (activePanel) {
            activePanel.reveal();
        } else {
            activePanel = vscode.window.createWebviewPanel(
                panelId,
                panelTitle,
                viewColumn,
                { enableScripts: true }
            );
            activePanel.webview.html = getWebviewContent();
            activePanel.webview.onDidReceiveMessage(async (message) => {
                console.debug('Message received from webview:', message);
                switch (message.command) {
                    case 'createGroup': {
                        vscode.window.showInputBox({ prompt: 'Enter new group name' })
                        .then(groupName => {
                            if (groupName) {
                                createGroup(groupName);
                                updateWebviewContent();
                            }
                        });
                        break;
                    }
                    case 'removeGroup': {
                        const { group } = message;
                        if (group) {
                            console.debug('Removing group:', group);
                            removeGroup(group);
                        } else {
                            vscode.window.showErrorMessage('Error: group not specified.');
                        }
                        break;
                    }
                    case 'showGroupTabs': {
                        const { group } = message;
                        if (group) {
                            console.debug('Showing all tabs of group:', group);
                            await showGroupTabs(group);
                        } else {
                            vscode.window.showErrorMessage('Error: group not specified.');
                        }
                        break;
                    }
                    case 'hideGroupTabs': {
                        const { group } = message;
                        if (group) {
                            console.debug('Hiding all tabs of group:', group);
                            await hideGroupTabs(group);
                        } else {
                            vscode.window.showErrorMessage('Error: group not specified.');
                        }
                        break;
                    }
                    case 'addFileToGroup': {
                        const { group, file, path } = message;
                        if (group && file) {
                            console.debug('Adding file ' + file + ' to group ' + group)
                            addToGroup(group, file, path);
                        } else {
                            vscode.window.showErrorMessage('Error: group or file not specified.')
                        }
                        break;
                    }
                    case 'removeFileFromGroup': {
                        const { group, file } = message;
                        if (group && file) {
                            console.debug('Removing file ' + file + ' from group ' + group);
                            removeFromGroup(group, file);
                        } else {
                            vscode.window.showErrorMessage('Error: group or file not specified.');
                        }
                        break;
                    }
                    case 'showFileFromGroup': {
                        const { group, filePath } = message;
                        openFile(filePath);
                        break;
                    }
                    case 'hideFileFromGroup': {
                        const { group, filePath } = message;
                        closeFile(filePath);
                        break;
                    }
                    default:
                        vscode.window.showErrorMessage('Unknown command.');
                        break;
                }
            });
        }
    });
    subscriptions.push(openGroupManagerCommand);
    // Right-click context menu command for files in explorer
    const fileContextMenuCommand = vscode.commands.registerCommand('extension.addFileToGroupFromExplorer', async (uri) => {
        if (!uri) {
            vscode.window.showErrorMessage('No file selected.');
            return;
        }
        const fileName = uri.fsPath.split('/').pop();
        const existingGroup = findGroupForFile(fileName);
        if (existingGroup) {
            openFile(uri.fsPath);
            vscode.window.showInformationMessage('File is already in group.');
        } else {
            const groupNames = Object.keys(groups);
            if (groupNames.length > 0) {
                const selectedGroup = await vscode.window.showQuickPick([...groupNames, 'Create New Group'], {
                    placeHolder: 'Select a group or create a new one',
                });
                if (selectedGroup === 'Create New Group') {
                    const groupName = await vscode.window.showInputBox({ prompt: 'Enter new group name' });
                    if (groupName) {
                        createGroup(groupName);
                        addToGroup(groupName, fileName, uri.fsPath);
                        openFile(uri.fsPath);
                    }
                } else if (selectedGroup) {
                    addToGroup(selectedGroup, fileName, uri.fsPath);
                    openFile(uri.fsPath);
                }
            } else {
                const groupName = await vscode.window.showInputBox({ prompt: 'Enter new group name' });
                if (groupName) {
                    createGroup(groupName);
                    addToGroup(groupName, fileName, uri.fsPath);
                    openFile(uri.fsPath);
                }
            }
        }
    });
    subscriptions.push(fileContextMenuCommand);

    // Visible editors changes listener
    vscode.window.onDidChangeVisibleTextEditors(() => {
        updateWebviewContent();
    });
    // Active editor changes listener
    vscode.window.onDidChangeActiveTextEditor(() => {
        updateWebviewContent();
    });
    // Editor closes listener
    vscode.workspace.onDidCloseTextDocument(() => {
        updateWebviewContent();
    });
    // Window state changes listener
    vscode.window.onDidChangeWindowState(() => {
        updateWebviewContent();
    });
    // Add subscriptions / commands
    subscriptions.forEach(subscription => context.subscriptions.push(subscription));
}

/**
 * Open file on editor.
 * @param {string} path File path.
 */
async function openFile(path) {
    const uri = vscode.Uri.file(path);
    vscode.workspace.openTextDocument(uri).then(async doc => {
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
    });
}

/**
 * Close file on editor.
 * @param {string} path File path.
 */
async function closeFile(path) {
    const openFiles = getOpenFiles(false);
    const targetFile = openFiles.find(file => file.input.uri.fsPath === path);
    try {
        await vscode.window.tabGroups.close(targetFile);
    } catch (error) {
        vscode.window.showErrorMessage(`Error closing file ${path}: ${error.message}`);
    }
}

/**
 * Finds file if exists on any group.
 * @param {string} fileName File name.
 * @returns {string|null} Group name if exists, or null if not.
 */
function findGroupForFile(fileName) {
    for (const [groupName, group] of Object.entries(groups)) {
        for (const file of group.files) {
            if (file.name === fileName) {
                return groupName;
            }
        }
    }
    return null;
}

/**
 * Create a group with a name and a random color.
 * @param {string} name Group name.
 */
function createGroup(name) {
    const color = getRandomColor();
    groups[name] = { color, files: [] };
    vscode.window.showInformationMessage(`Group ${name} created successfully.`);
}

/**
 * Removes a group.
 * @param {string} groupName Group name.
 */
function removeGroup(groupName) {
    if (groups[groupName]) {
        delete groups[groupName];
        updateWebviewContent();
        vscode.window.showInformationMessage(`Group ${groupName} removed successfully.`);
    } else {
        vscode.window.showErrorMessage(`Group ${groupName} does not exist.`);
    }
}

/**
 * Show all tabs of a group.
 * @param {string} groupName Group name.
 */
async function showGroupTabs(groupName) {
    if (groups[groupName]) {
        for (const file of groups[groupName].files) {
            await openFile(file.path); // Asegura que se abra cada archivo antes de continuar
        }
        updateWebviewContent();
        vscode.window.showInformationMessage(`Group ${groupName} tabs displayed successfully.`);
    } else {
        vscode.window.showErrorMessage(`Group ${groupName} does not exist.`);
    }
}

/**
 * Hide all tabs of a group.
 * @param {string} groupName Group name.
 */
async function hideGroupTabs(groupName) {
    if (groups[groupName]) {
        for (const file of groups[groupName].files) {
            await closeFile(file.path);
        }
        updateWebviewContent();
        vscode.window.showInformationMessage(`Group ${groupName} tabs hidden successfully.`);
    } else {
        vscode.window.showErrorMessage(`Group ${groupName} does not exist.`);
    }
}

/**
 * Add file to a group.
 * @param {string} groupName Group name.
 * @param {string} fileName File name.
 * @param {string} path File absolute path.
 */
function addToGroup(groupName, fileName, path) {
    if (groups[groupName]) {
        const fileAlreadyExists = groups[groupName].files.some(file => file.path === path);
        if (!fileAlreadyExists) {
            groups[groupName].files.push({
                name: fileName,
                path: path,
            });
            updateWebviewContent();
            vscode.window.showInformationMessage(`File added to group ${groupName}.`);
        } else {
            vscode.window.showWarningMessage(`File is already in this group.`);
        }
    } else {
        vscode.window.showErrorMessage(`Group ${groupName} does not exists.`);
    }
}

/**
 * Removes file from a group
 * @param {string} groupName Group name.
 * @param {string} fileName File name.
 */
function removeFromGroup(groupName, fileName) {
    if (groups[groupName]) {
        const fileIndex = groups[groupName].files.findIndex(file => file.name === fileName);
        if (fileIndex !== -1) {
            groups[groupName].files.splice(fileIndex, 1);
            updateWebviewContent();
            vscode.window.showInformationMessage(`File ${fileName} removed from group '${groupName}'.`);
        } else {
            vscode.window.showWarningMessage(`File ${fileName} is not in group '${groupName}'.`);
        }
    } else {
        vscode.window.showErrorMessage(`Group ${groupName} does not exist.`);
    }
}

/**
 * Generate random color with hexadecimal format.
 * @returns {string} Random color with format `#RRGGBB`.
 */
function getRandomColor() {
    const randomColor = Math.floor(Math.random() * 0xffffff).toString(16);
    return `#${randomColor.padStart(6, '0')}`;
}

/**
 * Get editor open files
 * @returns {vscode.Tab[]} Tabs array.
 */
function getOpenFiles(exclude_grouped = true) {
    const allOpenFiles = vscode.window.tabGroups.all
        .flatMap(group => group.tabs)
        .filter(tab => tab.input && tab.input.uri) // Exclude tabs without file
        .filter(tab => tab.label !== panelTitle) // Exclude the tabs groups manager itself
    const groupedFiles = Object.values(groups).flatMap(group => group.files.map(file => file.path));
    var openFiles = allOpenFiles;
    if (exclude_grouped) {
        openFiles = allOpenFiles.filter(file => !groupedFiles.includes(file.input.uri.fsPath)); // Exclude those that are already grouped
    }
    return openFiles;
}

/**
 * Check if files is already opened
 * @param {string} path Absolute file path.
 * @returns {boolean} Returns true when file is already opened.
 */
function isFileOpened(path) {
    return getOpenFiles(false).some(openFile => openFile.input.uri.fsPath === path);
}

/**
 * Generate Webview HTML content.
 * @returns {string} HTML string.
 */
function getWebviewContent() {
    const openFiles = getOpenFiles();
    const groupsHtml = Object.entries(groups)
        .map(([groupName, group]) => {
            const filesHtml = group.files
                .map(file => `
                    <li>
                        ${file.name} 
                        <button onclick="removeFile('${groupName}', '${file.name}')">Remove</button>
                        <button onclick="showFile('${groupName}', '${file.path}')">Show</button>
                        <button onclick="hideFile('${groupName}', '${file.path}')">Hide</button>
                    </li>
                `)
                .join('');
            return `
                <div class="group" style="border: 2px solid ${group.color}; margin: 10px; padding: 10px;"
                    ondrop="drop(event, '${groupName}')" ondragover="allowDrop(event)">
                    <h3 style="color: #e8e8e8;">${groupName} (${group.files.length})</h3>
                    <ul>${filesHtml}</ul>
                    <button onclick="removeGroup('${groupName}')">Delete Group</button>
                    <button onclick="showGroupTabs('${groupName}')">Show All</button>
                    <button onclick="hideGroupTabs('${groupName}')">Hide All</button>
                </div>`;
        })
        .join('');
    // Create open files list
    var filesHtml = '';
    if (openFiles.length > 0) {
        filesHtml = openFiles.map(file => `
            <div class="file" draggable="true" ondragstart="drag(event, '${file.label}', '${file.input.uri.fsPath}')">${file.label}</div>
        `).join('');
    }
    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${panelTitle}</title>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    padding: 10px;
                }
                .file {
                    padding: 10px;
                    margin: 5px 0;
                    background-color: #007acc;
                    color: white;
                    border: none;
                    border-radius: 5px;
                    cursor: grab;
                    text-align: center;
                }
                .file:hover {
                    background-color: #005f99;
                }
                .group {
                    padding: 10px;
                    border-radius: 5px;
                    background-color: #1e1e1e;
                }
                .group ul {
                    padding-left: 20px;
                }
                .group ul li {
                    list-style-type: disc;
                    color: white;
                }
                #open-files section {
                    display: flex;
                    gap: 0.65rem;
                    justify-content: left;
                    vertical-align: center;
                }
            </style>
        </head>
        <body>
            <h1>${panelTitle}</h1>
            <div id="groups">
                <h2>Groups</h2>
                <button onclick="vscode.postMessage({ command: 'createGroup' })">Create Group</button>
                ${groupsHtml}
            </div>
            <div id="open-files">
                ${filesHtml !== '' ? '<h2>Open tabs</h2>' : ''}
                <section>
                    ${filesHtml}
                </section>
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                function allowDrop(event) { event.preventDefault(); }
                function drag(event, fileName, path) {
                    var data = {};
                    data.fileName = fileName;
                    data.path = path;
                    event.dataTransfer.setData("text/plain", JSON.stringify(data));
                }
                function drop(event, groupName, path) {
                    event.preventDefault();
                    var data = event.dataTransfer.getData("text/plain");
                    data = JSON.parse(data);
                    vscode.postMessage({
                        command: 'addFileToGroup',
                        group: groupName,
                        file: data.fileName,
                        path: data.path,
                    });
                }
                function removeFile(groupName, fileName) {
                    vscode.postMessage({ command: 'removeFileFromGroup', group: groupName, file: fileName });
                }
                function showFile(groupName, filePath) {
                    vscode.postMessage({ command: 'showFileFromGroup', group: groupName, filePath: filePath });
                }
                function hideFile(groupName, filePath) {
                    vscode.postMessage({ command: 'hideFileFromGroup', group: groupName, filePath: filePath });
                }
                function removeGroup(groupName) {
                    vscode.postMessage({ command: 'removeGroup', group: groupName });
                }
                function showGroupTabs(groupName) {
                    vscode.postMessage({ command: 'showGroupTabs', group: groupName });
                }
                function hideGroupTabs(groupName) {
                    vscode.postMessage({ command: 'hideGroupTabs', group: groupName });
                }
            </script>
        </body>
        </html>
    `;
}

/**
 * Update Webview Content UI.
 */
function updateWebviewContent() {
    if (activePanel) {
        const dynamicStyleContent = Object.entries(groups)
        .map(([groupName, group]) => `
            .tab-${groupName} {
                    border-top: 3px solid ${group.color};
            }
        `).join('');
        const updatedStyleContent = `
            ${dynamicStyleContent}
        `;
        styleContent = updatedStyleContent;
        if (style) {
            style.html(updatedStyleContent);
        } else {
            writeOnVsCode(scriptContent, updatedStyleContent);
        }
        activePanel.webview.html = getWebviewContent();
    }
}

function writeOnVsCode(scriptContent, styleContent) {
    const appDir = require.main
		? path.dirname(require.main.filename)
		: globalThis._VSCODE_FILE_ROOT;
	const base = path.join(appDir, "vs", "code");
	htmlPath = path.join(base, "electron-sandbox", "workbench", "workbench.html");
	if (!fs.existsSync(htmlPath)) {
		htmlPath = path.join(base, "electron-sandbox", "workbench", "workbench.esm.html");
	}
	if (!fs.existsSync(htmlPath)) {
		vscode.window.showInformationMessage('VSCode path not found!');
	}
    fs.readFile(htmlPath, 'utf8', (err, data) => {
        if (err) {
            console.error('Error while reading VSCode layout', err);
            return;
        }
        const $ = cheerio.load(data);
        $('meta[http-equiv="Content-Security-Policy"]').remove();
        script = $('#'+scriptId);
        // Clean old script
        let scriptExists = script.length;
        if (scriptExists) {
            script.remove();
        }
        // Load script
        scriptContent = `
            // Clear old style
            if (document.getElementById('${styleId}')) {
                document.getElementById('${styleId}').remove();
            }
            // Load style
            const styleElement = document.createElement('style');
            styleElement.id = '${styleId}';
            styleElement.textContent = \`${styleContent}\`;
            document.head.append(styleElement);
        ` + scriptContent;
        $('html').append('<script id="' + scriptId + '">'+scriptContent+'</script>');
        // Set new layout
        fs.writeFile(htmlPath, $.html(), (err) => {
            if (err) {
                console.error('Error saving VSCode file', err);
            } else {
                console.log('VSCode File Correctly Saved')
            }
        });
    })
}

/**
 * Deactivate extension.
 */
function deactivate() {}

module.exports = {
	activate,
	deactivate
}
