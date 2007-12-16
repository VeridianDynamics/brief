// These have to be global vars instead of properties of a FeedView, because when new
// gFeedView is created, they have to be canceled.
var gMarkVisibleTimeout = null;
var gSelectScrollInterval = null;

/**
 * This object represents the main feed display. It stores and manages
 * the display parameters.
 *
 * @param aTitle  Title of the view which will be shown in the header.
 * @param aQuery  Query selecting entries to be displayed.
 */
function FeedView(aTitle, aQuery) {
    this.title = aTitle;

    this._flagsAreIntrinsic = aQuery.read || aQuery.unread || aQuery.starred ||
                              aQuery.unstarred || aQuery.deleted != ENTRY_STATE_NORMAL;
    this.query = aQuery;
    this.query.sortOrder = Ci.nsIBriefQuery.SORT_BY_DATE;

    // Clear the searchbar.
    if (!aQuery.searchString) {
        var searchbar = document.getElementById('searchbar');
        searchbar.setAttribute('showingDescription', true);
    }

    this._markedUnreadEntries = [];

    // If view is tied to specified intrinsic flags (e.g. special "Unread" view), hide
    // the UI to pick the flags from the user.
    var viewConstraintBox = document.getElementById('view-constraint-box');
    viewConstraintBox.hidden = this._flagsAreIntrinsic;

    this.browser.addEventListener('load', this._onLoad, false);

    this._refresh();
}


FeedView.prototype = {

    // Title of the view which is displayed in the header.
    title: '',

    // This property is used to temporarily override the title without losing the old one.
    // It used for searching, when the search string is displayed in place of the title.
    titleOverride: '',

    // Indicates if the view was created with intrinsic flags which override the
    // feedview.shownEntries preference.
    _flagsAreIntrinsic: false,

    // Array of ids of displayed entries. This isn't used to specify which entries are
    // displayed but computed post-factum and used for determining if the view needs
    // to be refreshed.
    _entries: [],

    // Key elements.
    get browser() document.getElementById('feed-view'),
    get document() this.browser.contentDocument,

    feedContent: null,


    // Query that selects entries contained by the view. It is the query to pull ALL the
    // entries, not only the ones displayed on the current page.
    __query: null,
    set query(aQuery) {
        this.__query = aQuery;
        return aQuery;
    },
    get query() {
        if (!this._flagsAreIntrinsic) {
            this.__query.unread = (gPrefs.shownEntries == 'unread');
            this.__query.starred = (gPrefs.shownEntries == 'starred');
            this.__query.deleted = gPrefs.shownEntries == 'trashed' ? ENTRY_STATE_TRASHED
                                                                    : ENTRY_STATE_NORMAL;
        }
        // XXX We should not have to reset the offset and limit every time.
        this.__query.limit = 0;
        this.__query.offset = 1;

        return this.__query;
    },


    pageCount:     0,
    entriesCount:  0,

    __currentPage: 1,
    set currentPage(aPageNumber) {
        if (aPageNumber != this.__currentPage && aPageNumber <= this.pageCount && aPageNumber > 0) {
            this.__currentPage = aPageNumber;
            this.ensure(true);
        }
    },
    get currentPage() this.__currentPage,


    // ID of the selected entry.
    selectedEntry: '',

    get selectedElement() {
        return this.selectedEntry ? this.document.getElementById(this.selectedEntry)
                                  : null;
    },

    // Used when going back one page by selecting previous
    // entry when the topmost entry is selected.
    _selectLastEntryOnRefresh: false,

    // Temporarily disable selecting entries.
    _selectionSuppressed: false,

    selectNextEntry: function FeedView_selectNextEntry() {
        if (!this._selectionSuppressed) {
            var entry = this.selectedElement ? this.selectedElement.nextSibling
                                             : this.feedContent.firstChild;
            if (entry)
                this.selectEntry(entry, true, true);
            else
                this.currentPage++;
        }
    },

    selectPrevEntry: function FeedView_selectPrevEntry() {
        if (!this._selectionSuppressed) {
            var entry = this.selectedElement ? this.selectedElement.previousSibling
                                             : this.feedContent.firstChild;

            if (entry) {
                this.selectEntry(entry, true, true);
            }
            // Normally we wouldn't have to check |currentPage > 1|, because
            // the setter validates the input. However, we don't want to set
            // _selectLastEntryOnRefresh and then not refresh.
            else if (this.currentPage > 1) {
                this._selectLastEntryOnRefresh = true;
                this.currentPage--;
            }
        }
    },

    /**
     * Selects the given entry and scrolls it into view, if desired.
     *
     * @param aEntry           ID od DOM element of entry to select. Can be null.
     * @param aScroll          Whether to scroll the entry into view.
     * @param aScrollSmoothly  Enable smooth scrolling.
     */
    selectEntry: function FeedView_selectEntry(aEntry, aScroll, aScrollSmoothly) {
        if (this.isActive) {
            var entry = (typeof aEntry == 'string' || !aEntry) ? aEntry : aEntry.id;

            if (this.selectedElement)
                this.selectedElement.removeAttribute('selected');

            this.selectedEntry = entry;

            if (entry) {
                this.selectedElement.setAttribute('selected', true);

                if (!gPrefs.keyNavEnabled)
                    gPrefs.setBoolPref('feedview.keyNavEnabled', true);

                if (aScroll)
                    this.scrollToEntry(entry, aScrollSmoothly);
            }
        }
    },

    /**
     * Scroll entry into view.
     *
     * @param aEntry  ID od DOM element of entry to select.
     * @param Smooth  Enable smooth scrolling.
     */
    scrollToEntry: function FeedView_scrollToEntry(aEntry, aSmooth) {
        var win = this.document.defaultView;
        var entryElement = (typeof aEntry == 'string') ? this.document.getElementById(aEntry)
                                                       : aEntry;

        if (entryElement.offsetHeight >= win.innerHeight) {
            // If the entry is taller than the viewport height, align with the top.
            var targetPosition = entryElement.offsetTop;
        }
        else {
            // Otherwise, scroll the entry to the middle of the screen.
            var difference = win.innerHeight - entryElement.offsetHeight;
            targetPosition = entryElement.offsetTop - Math.floor(difference / 2);
        }

        if (targetPosition < 0)
            targetPosition = 0;
        else if (targetPosition > win.scrollMaxY)
            targetPosition = win.scrollMaxY;

        if (targetPosition != win.pageYOffset) {
            if (aSmooth)
                this._scrollSmoothly(targetPosition);
            else
                win.scroll(win.pageXOffset, targetPosition);
        }
    },

    _scrollSmoothly: function FeedView__scrollSmoothly(aTargetPosition) {
        var win = this.document.defaultView;

        var delta = aTargetPosition - win.pageYOffset;
        var jump = Math.round(delta / 10);
        jump = (jump !== 0) ? jump : (delta > 0) ? 1 : -1;

        var self = this;

        function scroll() {
            // If we are within epsilon smaller than the jump,
            // then scroll directly to the target position.
            if (Math.abs(aTargetPosition - win.pageYOffset) <= Math.abs(jump)) {
                win.scroll(win.pageXOffset, aTargetPosition)
                clearInterval(gSelectScrollInterval);
                self._selectionSuppressed = false;
            }
            else {
                win.scroll(win.pageXOffset, win.pageYOffset + jump);
            }
        }
        // Disallow selecting futher entries until scrolling is finished.
        this._selectionSuppressed = true;

        gSelectScrollInterval = setInterval(scroll, 7);
    },


    // This array is used to prevent entries from being immediately re-marked as read,
    // when the user marks them as unread and autoMarkRead is on.
    // We maintain a list of entries, which were marked as unread by the user, and
    // exclude them from auto-marking for the duration of the view's life.
    _markedUnreadEntries: [],

    markVisibleAsRead: function FeedView_markVisibleAsRead() {
        var view = gFeedView;
        if (gPrefs.autoMarkRead && !gPrefs.showHeadlinesOnly && !view.query.unread) {
            clearTimeout(gMarkVisibleTimeout);
            gMarkVisibleTimeout = async(function(){ view._doMarkVisibleAsRead() }, 500);
        }
    },

    _doMarkVisibleAsRead: function FeedView__doMarkVisibleAsRead() {
        var win = this.document.defaultView;
        var winTop = win.pageYOffset;
        var winBottom = winTop + win.innerHeight;
        var entriesToMark = [], entryTop, wasMarkedUnread, i;

        var entries = this.feedContent.childNodes;

        for (i = 0; i < entries.length; i++) {
            entryTop = entries[i].offsetTop;
            wasMarkedUnread = (this._markedUnreadEntries.indexOf(entries[i].id) != -1);

            if (entryTop >= winTop && entryTop < winBottom - 50 && !wasMarkedUnread)
                entriesToMark.push(entries[i].id);
        }

        if (entriesToMark.length) {
            var query = new QuerySH(null, entriesToMark.join(' '), false);
            query.markEntriesRead(true);
        }
    },

    // Indicates whether the feed view is currently displayed in the browser.
    get isActive() {
        return this.browser.currentURI.equals(gTemplateURI);
    },

    get isGlobalSearch() {
        return !this.query.folders && !this.query.feeds && !this._flagsAreIntrinsic &&
               this.query.searchString;
    },

    get isViewSearch() {
        return (this.query.folders || this.query.feeds || this._flagsAreIntrinsic) &&
                gFeedView.query.searchString;
    },

    /**
     * Checks if the view is up-to-date (contains all the right entries nad has the
     * right title) and refreshes it if necessary.
     *
     * @returns TRUE if the view was up-to-date, FALSE if it needed refreshing.
     */
    ensure: function FeedView_ensure(aForceRefresh) {
        if (aForceRefresh && this.isActive) {
            this._refresh();
            return false;
        }

        var isDirty = false;

        if (!this.isActive || this.browser.webProgress.isLoadingDocument)
            return true;

        var prevEntries = this._entries;
        var currentEntriesCount = this.query.getEntriesCount();

        if (!prevEntries || !currentEntriesCount) {
            this._refresh();
            return false;
        }

        // If a single entry was removed we do partial refresh, otherwise we
        // refresh from scratch.
        // Because in practice it is extremely unlikely for some entries to be removed
        // and others added with a single operation, the number of entries always changes
        // when the entry set changes. This greatly simplifies things, because we don't
        // have to check entries one by one and we can just compare their number.
        if (this.entriesCount - currentEntriesCount == 1) {
            var removedEntry = null;
            var removedEntryIndex;
            var currentEntries = this.query.getSerializedEntries().
                                            getPropertyAsAString('entries').
                                            match(/[^ ]+/g);

            // Find the removed entry.
            for (var i = 0; i < prevEntries.length; i++) {
                if (currentEntries.indexOf(prevEntries[i]) == -1) {
                    removedEntry = prevEntries[i];
                    removedEntryIndex = i;
                    break;
                }
            }

            // If there are no more entries on this page and it the last
            // page then perform full refresh.
            if (this.feedContent.childNodes.length == 1 && this.currentPage == this.pageCount) {
                this.currentPage--;
                return false;
            }

            // If the removed entry is on a different page than the
            // currently shown one then perform full refresh.
            var firstIndex = gPrefs.entriesPerPage * (this.currentPage - 1);
            var lastIndex = firstIndex + gPrefs.entriesPerPage - 1;
            if (removedEntryIndex < firstIndex || removedEntryIndex > lastIndex) {
                this._refresh();
                return false;
            }

            this._refreshIncrementally(removedEntry);

            // Update this._entries here, so that this._refreshIncrementally()
            // doesn't have to call this.query.getSerializedEntries() again.
            this._entries = currentEntries;
            isDirty = true;
        }
        else if (this.entriesCount != currentEntriesCount) {
            this._refresh();
            return false;
        }

        // Update the title.
        var title = this.titleOverride || this.title;
        var titleElement = this.document.getElementById('feed-title');
        if (titleElement.textContent != title) {
            titleElement.textContent = title;
            isDirty = true;
        }

        return !isDirty;
    },


    // Refreshes the feed view from scratch.
    _refresh: function FeedView_refresh() {
        this.browser.style.cursor = 'wait';

        // Stop scrolling, so it doesn't continue after refreshing.
        clearInterval(gSelectScrollInterval);

        // Cancel auto-marking entries as read.
        clearTimeout(gMarkVisibleTimeout);

        // Suppress selecting entry until we refresh is finished.
        this._selectionSuppressed = true;

        // Load the template. The actual content building happens when the template
        // page is loaded - see _onLoad below.
        this.browser.loadURI(gTemplateURI.spec);

        // Store a list of ids of displayed entries. It is used to determine if
        // the view needs to be refreshed when database changes. This can be done
        // after timeout, so not to delay the view creation any futher.
        function setEntries() {
            gFeedView._entries = gFeedView.query.getSerializedEntries().
                                                 getPropertyAsAString('entries').
                                                 match(/[^ ]+/g);
        }
        async(setEntries, 500);
    },


    // Refreshes the view when one entry is removed from the currently displayed page.
    _refreshIncrementally: function FeedView__refreshIncrementally(aEntryID) {
        var entry = this.document.getElementById(aEntryID);

        var entryWasSelected = (entry == this.selectedEntry);
        if (entryWasSelected) {
            // Immediately deselect the entry, so that no futher commands can be sent.
            this.selectEntry(null);

            // Remember the next and previous siblings as we
            // may need to select one of them.
            var nextSibling = entry.nextSibling;
            var previousSibling = entry.previousSibling;
        }

        // Remove the entry. We don't do it directly, because we want to
        // use jQuery to to fade it gracefully and we cannot call it from
        // here, because it's untrusted.
        var evt = document.createEvent('Events');
        evt.initEvent('RemoveEntry', false, false);
        entry.dispatchEvent(evt);

        var self = this;
        function finish() {
            self._computePages();

            // Pull the entry to be added to the current page, which happens
            // to have been the first entry of the next page.
            var query = self.query;
            query.offset = gPrefs.entriesPerPage * self.currentPage - 1;
            query.limit = 1;
            var newEntry = query.getEntries({})[0];

            // Append the entry. If we're on the last page then there may
            // have been no futher entries to pull.
            var appendedEntry = null;
            if (newEntry)
                appendedEntry = self._appendEntry(newEntry);

            if (!self.feedContent.childNodes.length)
                self._setEmptyViewMessage();

            // Select another entry
            if (entryWasSelected)
                self.selectEntry(nextSibling || appendedEntry || previousSibling || null);
        }

        // Don't append the new entry until the old one is removed.
        async(finish, 310);
    },


    // Computes the current entries count, page counter, current page ordinal and
    // refreshes the navigation UI.
    _computePages: function FeedView__computePages() {
        this.entriesCount = this.query.getEntriesCount();
        this.pageCount = Math.ceil(this.entriesCount / gPrefs.entriesPerPage) || 1;

        // This may happen for example when you are on the last page, and the
        // number of entries decreases (e.g. they are deleted).
        if (this.currentPage > this.pageCount)
            this.__currentPage = this.pageCount;

        // Update the page commands and description
        var pageLabel = document.getElementById('page-desc');
        var prevPageButton = document.getElementById('prev-page');
        var nextPageButton = document.getElementById('next-page');

        prevPageButton.setAttribute('disabled', this.currentPage <= 1);
        nextPageButton.setAttribute('disabled', this.currentPage == this.pageCount);
        var stringbundle = document.getElementById('main-bundle');
        var params = [this.currentPage, this.pageCount];
        pageLabel.value = stringbundle.getFormattedString('pageNumberLabel', params);
    },


    // Listens to load events and builds the feed view page when necessary as
    // well as hides/unhides the feed view toolbar.
    _onLoad: function FeedView__onLoad(aEvent) {
        var feedViewToolbar = document.getElementById('feed-view-toolbar');
        gFeedView.browser.contentDocument.
                  addEventListener('mousedown', gFeedViewEvents.onFeedViewMousedown, true);

        if (gFeedView.isActive) {
            feedViewToolbar.hidden = false;
            gFeedView._buildFeedView();
        }
        else {
            feedViewToolbar.hidden = true;
        }
    },


    // Generates and sets up the feed view page. Because we insert third-party
    // content in it (the entries are not served in plain text but in full HTML
    // markup) this page needs to be have a file:// URI to be unprivileged.
    // It is untrusted and all the interaction respects XPCNativeWrappers.
    _buildFeedView: function FeedView__buildFeedView() {
        var doc = this.document;

        // Add listeners so that the content can communicate with chrome to perform
        // actions that require full privileges by sending custom events.
        doc.addEventListener('MarkEntryRead', gFeedViewEvents.onMarkEntryRead, true);
        doc.addEventListener('StarEntry', gFeedViewEvents.onStarEntry, true);
        doc.addEventListener('DeleteEntry', gFeedViewEvents.onDeleteEntry, true);
        doc.addEventListener('RestoreEntry', gFeedViewEvents.onRestoreEntry, true);
        doc.addEventListener('EntryCollapsed', gFeedViewEvents.onEntryCollapsed, true);

        // See comments next to the event handler functions.
        doc.addEventListener('click', gFeedViewEvents.onFeedViewClick, true);

        doc.addEventListener('keypress', onKeyPress, true);
        doc.addEventListener('scroll', this.markVisibleAsRead, true);

        // Apply the CSS.
        var style = doc.getElementById('feedview-style');
        style.textContent = gFeedViewStyle;

        // Build the header...
        var titleElement = doc.getElementById('feed-title');
        titleElement.textContent = this.titleOverride || this.title;

        // When a single, unfiltered feed is viewed, construct the
        // feed's header: the subtitle, the image, and the link.
        var feed = gStorage.getFeed(this.query.feeds);
        if (feed && !this.searchString) {

            // Create the link.
            var header = doc.getElementById('header');
            header.setAttribute('href', feed.websiteURL ? feed.websiteURL : feed.feedURL);

            // Create feed image.
            if (feed.imageURL) {
                var feedImage = doc.getElementById('feed-image');
                feedImage.setAttribute('src', feed.imageURL);
                if (feed.imageTitle)
                    feedImage.setAttribute('title', feed.imageTitle);
            }

            // Create feed subtitle.
            if (feed.subtitle)
                doc.getElementById('feed-subtitle').innerHTML = feed.subtitle;
        }

        this.feedContent = doc.getElementById('feed-content');

        // If the trash folder is displayed this attribute is used for
        // setting visibility of buttons in article controls.
        if (this.query.deleted == ENTRY_STATE_TRASHED)
            this.feedContent.setAttribute('trash', true);

        // Show feed name in entry's subheader when displaying entries
        // from multiple feeds.
        if (!feed)
            this.feedContent.setAttribute('showFeedNames', true);

        // Pass values of the necessary preferences.
        if (gPrefs.showHeadlinesOnly)
            this.feedContent.setAttribute('showHeadlinesOnly', true);
        if (gPrefs.doubleClickMarks)
            this.feedContent.setAttribute('doubleClickMarks', true);

        // We have to hand the strings because stringbundles don't
        // work with unprivileged script.
        this.feedContent.setAttribute('markReadString', this.markAsReadStr);
        this.feedContent.setAttribute('markUnreadString', this.markAsUnreadStr);

        var query = this.query;
        query.offset = gPrefs.entriesPerPage * (this.currentPage - 1);
        query.limit = gPrefs.entriesPerPage;

        var entries = query.getEntries({});

        // Important: for better performance we try to delay computing pages until
        // after the view is displayed. However, the whole reason why we recompute
        // pages is that their number may have changed and we need to know that to
        // correctly refresh the view.
        // The only time when recomputing pages may affect the currently displayed
        // entry set is when currentPage goes out of range if the view is now containing
        // less pages than before. This in turn makes the offset invalid and the query
        // returns no entries.
        // To avoid that, whenever the query returns no entries we force immediate
        // recomputation of pages to make sure that they are correct and then we redo
        // the query.
        if (!entries.length) {
            this._computePages();
            query.offset = gPrefs.entriesPerPage * (this.currentPage - 1);
            query.limit = gPrefs.entriesPerPage;
            entries = query.getEntries({});
        }
        else {
            async(this._computePages, 0, this);
        }

        for (var i = 0; i < entries.length; i++)
            this._appendEntry(entries[i]);

        if (!entries.length)
            this._setEmptyViewMessage();

        // Select an entry if keyboard navigation is enabled.
        this._selectionSuppressed = false;
        if (gPrefs.keyNavEnabled) {

            if (this.selectedElement) {
                this.selectEntry(this.selectedEntry, true);
            }
            else if (this._selectLastEntryOnRefresh) {
                entry = this.feedContent.lastChild;
                this.selectEntry(entry, true);
            }
            else {
                entry = this.feedContent.firstChild;
                this.selectEntry(entry);
            }

            this._selectLastEntryOnRefresh = false;
        }

        this.markVisibleAsRead();

        // Restore default cursor which we changed to
        // "wait" at the beginning of the refresh.
        this.browser.style.cursor = 'auto';
    },


    _appendEntry: function FeedView__appendEntry(aEntry) {
        var articleContainer = this.document.createElementNS(XHTML_NS, 'div');
        articleContainer.className = 'article-container';

        // Safely pass the data so that binding constructor can use it.
        articleContainer.setAttribute('id', aEntry.id);
        articleContainer.setAttribute('entryURL', aEntry.entryURL);
        articleContainer.setAttribute('entryTitle', aEntry.title);
        articleContainer.setAttribute('content', aEntry.content);

        if (gPrefs.showAuthors && aEntry.authors) {
            articleContainer.setAttribute('authors', this.authorPrefixStr + aEntry.authors);
        }
        if (aEntry.read)
            articleContainer.setAttribute('read', true);
        if (aEntry.starred)
            articleContainer.setAttribute('starred', true);

        if (aEntry.date) {
            var entryDate = new Date(aEntry.date);
            var entryTime = entryDate.getTime() - entryDate.getTimezoneOffset() * 60000;

            var now = new Date();
            var nowTime = now.getTime() - now.getTimezoneOffset() * 60000;

            var today = Math.ceil(nowTime / 86400000);
            var entryDay = Math.ceil(entryTime / 86400000);
            var deltaDays = today - entryDay;

            var deltaYears = Math.ceil(today / 365) - Math.ceil(entryDay / 365);

            var string = '';
            switch (true) {
                case deltaDays === 0:
                    string = entryDate.toLocaleFormat(', %X ');
                    string = this.todayStr + string;
                    break;
                case deltaDays === 1:
                    string = entryDate.toLocaleFormat(', %X ');
                    string = this.yesterdayStr + string
                    break;
                case deltaDays < 7:
                    string = entryDate.toLocaleFormat('%A, %X ');
                    break;
                case deltaYears > 0:
                    string = entryDate.toLocaleFormat('%d %B %Y, %X ');
                    break;
                default:
                    string = entryDate.toLocaleFormat('%d %B, %X ');
            }

            string = string.replace(/:\d\d /, ' ');
            // XXX We do it because %e conversion specification doesn't work
            string = string.replace(/^0/, '');

            articleContainer.setAttribute('date', string);

            if (aEntry.updated) {
                string += ' <span class="article-updated">' + this.updatedStr + '</span>'
                articleContainer.setAttribute('updated', string);
            }
        }

        var feedName = gStorage.getFeed(aEntry.feedID).title;
        articleContainer.setAttribute('feedName', feedName);

        if (gPrefs.showHeadlinesOnly)
            articleContainer.setAttribute('collapsed', true);

        this.feedContent.appendChild(articleContainer);

        return articleContainer;
    },

    _setEmptyViewMessage: function FeedView__setEmptyViewMessage() {
        var paragraph = this.document.getElementById('message');
        var bundle = document.getElementById('main-bundle');
        var message;

        if (this.query.searchString)
            message = bundle.getString('noEntriesFound');
        else if (this.query.unread)
            message = bundle.getString('noUnreadEntries');
        else if (this.query.starred && this._flagsAreIntrinsic)
            message = bundle.getString('noStarredEntries');
        else if (this.query.starred)
            message = bundle.getString('noStarredEntriesInFeed');
        else if (this.query.deleted == ENTRY_STATE_TRASHED)
            message = bundle.getString('trashIsEmpty');
        else
            message = bundle.getString('noEntries');

        paragraph.textContent = message;
        paragraph.style.display = 'block';
    }

}


// Listeners for actions performed in the feed view.
var gFeedViewEvents = {

    onMarkEntryRead: function feedViewEvents_onMarkEntryRead(aEvent) {
        var entryID = aEvent.target.getAttribute('id');
        var readStatus = aEvent.target.hasAttribute('read');
        var query = new QuerySH(null, entryID, null);
        query.deleted = ENTRY_STATE_ANY;
        query.markEntriesRead(readStatus);

        if (gPrefs.autoMarkRead && !readStatus)
            gFeedView._markedUnreadEntries.push(entryID);
    },


    onDeleteEntry: function feedViewEvents_onDeleteEntry(aEvent) {
        var entryID = aEvent.target.getAttribute('id');
        var query = new QuerySH(null, entryID, null);
        query.deleteEntries(ENTRY_STATE_TRASHED);
    },


    onRestoreEntry: function feedViewEvents_onRestoreEntry(aEvent) {
        var entryID = aEvent.target.getAttribute('id');
        var query = new QuerySH(null, entryID, null);
        query.deleted = ENTRY_STATE_TRASHED;
        query.deleteEntries(ENTRY_STATE_NORMAL);
    },


    onStarEntry: function feedViewEvents_onStarEntry(aEvent) {
        var entryID = aEvent.target.getAttribute('id');
        var newStatus = aEvent.target.hasAttribute('starred');
        var query = new QuerySH(null, entryID, null);
        query.starEntries(newStatus);
    },

    onEntryCollapsed: function feedViewEvents_onEntryCollapsed(aEvent) {
        if (gPrefs.autoMarkRead && gPrefs.showHeadlinesOnly && !gFeedView.query.unread
            && !aEvent.target.hasAttribute('collapsed')) {

            var query = new QuerySH(null, aEvent.target.id, null);
            query.markEntriesRead(true);
        }
    },


    // This is for marking entry read when user follows the link. We can't do it
    // by dispatching custom events like we do above, because for whatever
    // reason the binding handlers don't catch middle-clicks.
    onFeedViewClick: function feedViewEvents_onFeedViewClick(aEvent) {
        var anonid = aEvent.originalTarget.getAttribute('anonid');
        var targetEntry = aEvent.target;

        if (gPrefs.keyNavEnabled && targetEntry.className == 'article-container')
            gFeedView.selectEntry(targetEntry);

        if (anonid == 'article-title-link' && (aEvent.button == 0 || aEvent.button == 1)) {
            aEvent.preventDefault();

            // Prevent default doesn't seem to stop the default action when
            // middle-clicking, so we've got stop propagation as well.
            if (aEvent.button == 1)
                aEvent.stopPropagation();

            var openEntriesInTabs = gPrefs.getBoolPref('feedview.openEntriesInTabs');
            var newTab = (aEvent.button == 0 && openEntriesInTabs || aEvent.button == 1);
            gCommands.openEntryLink(targetEntry, newTab);
        }
    },


    // By default document.popupNode doesn't dive into anonymous content
    // and returns the bound element; hence there's no context menu for
    // content of entries. To work around it, we listen for the mousedown
    // event and store the originalTarget, so it can be manually set as
    // document.popupNode (see gBrief.contextMenuOverride()
    // in brief-overlay.js).
    onFeedViewMousedown: function feedViewEvents_onFeedViewMousedown(aEvent) {
        if (aEvent.button == 2 && gFeedView.isActive)
            gTopBrowserWindow.gBrief.contextMenuTarget = aEvent.originalTarget;
        else
            gTopBrowserWindow.gBrief.contextMenuTarget = null;
    }

}
