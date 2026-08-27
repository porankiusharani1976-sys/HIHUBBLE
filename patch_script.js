const fs = require('fs');
const content = fs.readFileSync('src/main.js', 'utf8');
const newContent = content.replace(/if \(!groupedStories\[authorId\]\) \{[\s\S]*?groupedStories\[authorId\]\.stories\.push\(\{/g, (match) => {
    return match.replace(/authorId/g, 'storyId');
});
fs.writeFileSync('src/main_patched.js', newContent);
