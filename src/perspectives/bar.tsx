import * as React from "react";
import { Badge } from "react-badger";

import { areWorkbenchStatesEqualIgnoringSelection } from "./compare";
import { IPerspective } from "./perspective";
import { IPerspectiveStorage } from "./storage";

import { IWorkbenchState } from "../types";
import { Workbench } from "../workbench";

/**
 * Props of the perspective bar component.
 */
export interface IPerspectiveBarProps {
  /**
   * Error message to show on the perspective bar when the perspectives cannot
   * be loaded from the storage.
   */
  errorMessage?: string;

  /**
   * Function to call when the selected perspective is about to be changed.
   *
   * The function will be called with the new perspective ID that is about
   * to become active. The function must return true if it wishes to
   * _prevent_ the default behaviour of the perspective bar, which is to
   * load the perspective that the user has selected.
   */
  onChange?: (id: string) => boolean | void;

  /**
   * Prop that allows the user to control the selected perspective ID from
   * the outside.
   */
  selectedPerspectiveId?: string | undefined;

  /**
   * The perspective storage that the perspective bar uses to store
   * perspectives.
   */
  storage?: IPerspectiveStorage;

  /**
   * The workbench that the perspective bar is associated to.
   */
  workbench: Workbench;
}

/**
 * State of the perspective bar component.
 */
export interface IPerspectiveBarState {
  /**
   * Dummy counter that can be used to force updates to the perspective bar.
   */
  counter: number;

  /**
   * Whether the last loading attempt ended with an error.
   */
  error: boolean;

  /**
   * Array containing all the perspectives that were loaded by the previous
   * attempt. undefined if the perspectives have not been loaded yet or if the
   * loading attempt ended with an error.
   */
  perspectives: Array<[string, IPerspective]> | undefined;

  /**
   * A promise that will eventually resolve to the list of perspectives in the
   * perspective bar. When undefined, the perspective bar is not loading
   * anything.
   */
  promise: Promise<Array<[string, IPerspective]>> | undefined;

  /**
   * ID of the selected perspective that the user is currently editing if
   * the component is not controlled from the outside via props.
   */
  selectedPerspectiveId: string | undefined;
}

export class PerspectiveBar extends React.Component<IPerspectiveBarProps, IPerspectiveBarState> {

  /**
   * When this variable is positive, the next state change event from the
   * workbench will be ignored and the variable will be decremented by one.
   * When this variable is zero or negative, the state change event from
   * the workbench will update the <code>perspectiveChanged</code> state
   * variable of the bar.
   */
  private _ignoreStateChangeCounter: number;

  /**
   * The last known state of the workbench.
   */
  private _lastState: IWorkbenchState | undefined;

  private _storage: IPerspectiveStorage | undefined;
  private _workbench: Workbench | undefined;

  public static getDerivedStateFromProps(props: IPerspectiveBarProps) {
    if (props.hasOwnProperty("selectedPerspectiveId")) {
      // If the component is controlled, selectedPerspectiveId in state should
      // be copied from props
      return { selectedPerspectiveId: props.selectedPerspectiveId };
    } else {
      return null;
    }
  }

  constructor(props: IPerspectiveBarProps) {
    super(props);
    this._ignoreStateChangeCounter = 0;
    this.state = {
      counter: 0,
      error: false,
      perspectives: undefined,
      promise: undefined,
      selectedPerspectiveId: undefined
    };
  }

  public componentDidMount() {
    this._setStorage(this.props.storage);
    this._setWorkbench(this.props.workbench);
    this._startLoadingIfNeeded();
  }

  public componentDidUpdate() {
    this._setStorage(this.props.storage);
    this._setWorkbench(this.props.workbench);
    this._startLoadingIfNeeded();
  }

  public componentWillUnmount() {
    this._setStorage(undefined);
    this._setWorkbench(undefined);
    this._cancelLoading();
  }

  public render() {
    const { errorMessage, storage } = this.props;
    const { error, perspectives, promise, selectedPerspectiveId } = this.state;
    const buttons: React.ReactNode[] = [];
    const loading = promise !== undefined;

    if (perspectives !== undefined) {
      perspectives.forEach(pair => {
        const [id, perspective] = pair;
        const element = this._createLoadButtonFromStoredPerspective(
          perspective, id, storage ? storage.isModified(id) : false
        );
        const selected = selectedPerspectiveId === id;
        const extraProps: Partial<ILoadPerspectiveButtonProps> = {
          onClick: this._onPerspectiveButtonClicked.bind(this, id),
          selected
        };
        buttons.push(React.cloneElement(element, extraProps));
      });
      buttons.push(<NewPerspectiveButton key="__new" onClick={this._createNewPerspective} />);
      buttons.push(<SavePerspectiveButton key="__save" onClick={this._persistModificationsOfCurrentPerspective}
                                          disabled={storage ? !storage.isModified(selectedPerspectiveId) : true} />);
    } else if (error) {
      buttons.push(
        <ReloadPerspectivesButton key="__reload"
          label={errorMessage}
          onClick={() => this._forceReload()} />
        );
    }

    if (buttons.length === 0 && loading) {
      buttons.push(<span key="__loading">Loading...</span>);
    }

    return <div className="wb-perspective-bar">{buttons}</div>;
  }

  /**
   * Cancels the current attempt to load the list of perspectives.
   */
  private _cancelLoading = () => {
    this.setState({
      promise: undefined
    });
  }

  private _createLoadButtonFromStoredPerspective =
    (perspective: IPerspective, id: string, modified: boolean): React.ReactElement<ILoadPerspectiveButtonProps> => {
    const { label } = perspective;
    return (
      <LoadPerspectiveButton key={id} label={label} modified={modified} />
    );
  }

  private _createNewPerspective = async (): Promise<void> => {
    const { workbench } = this.props;
    const { environment } = workbench;
    const perspective: IPerspective = {
      label: "",
      state: workbench.getState()
    };
    const confirmation = await environment.onCreatingNewPerspective(perspective);
    if (confirmation) {
      const { storage } = this.props;
      if (storage !== undefined) {
        const id = await storage.save(perspective);
        this._requestSelectedPerspectiveIdChange(id);
        this._lastState = perspective.state;
      } else {
        console.warn("No perspective storage while creating new perspective; this is probably a bug.");
      }
    }
  }

  /**
   * Determines whether the state of the current perspective needs to be saved
   * after a `stateChanged` event.
   *
   * The problem we are solving here is that `stateChanged` is fired not only
   * for item creations / rearrangements but also when the user changes the
   * selection in the perspective. We want to ignore selection changes but save
   * the perspective state whenever an actual change happens.
   *
   * @param  {IPerspective}  newState  the new state of the workbench
   * @return {boolean}  if the new state of the workbench is different from the
   *         state of the current perspective in the perspective storage,
   *         ignoring selection changes
   */
  private _currentPerspectiveNeedsSavingAfterChange(newState: IWorkbenchState): boolean {
    return this.state.selectedPerspectiveId !== undefined &&
      this._lastState !== undefined &&
      !areWorkbenchStatesEqualIgnoringSelection(this._lastState, newState);
  }

  /**
   * Forces the component to reload the current list of perspectives from
   * the storage backend.
   */
  private _forceReload = () => {
    this.setState({
      counter: 1 - this.state.counter,
      error: false,
      perspectives: undefined,
      promise: undefined
    });
  }

  private _loadPerspectiveById = async (id: string): Promise<void> => {
    const { storage } = this.props;
    if (storage !== undefined) {
      const perspective = await storage.load(id);
      const { workbench } = this.props;
      if (workbench !== undefined) {
        this._ignoreStateChangeCounter++;
        workbench.restoreState(perspective.state);
      } else {
        console.warn("Workbench is gone while the perspective was being loaded; this is probably a bug.");
      }
      this._lastState = workbench.getState();     // there are extra keys there compared to perspective.state
      this.setState({
        selectedPerspectiveId: id
      });
    } else {
      console.warn("No perspective storage while loading perspective by ID; this is probably a bug.");
    }
  }

  private _onPerspectiveButtonClicked = (id: string): void => {
    const { selectedPerspectiveId } = this.state;
    if (selectedPerspectiveId === id) {
      // Reverting modification of current perspective
      this._revertModificationsOfCurrentPerspective();
    } else {
      // Call the onChange handler if any, and then load the perspective if
      // the user did not prevent the default behaviour
      const { onChange } = this.props;
      if (!onChange || !onChange(id)) {
        this._loadPerspectiveById(id);
      }
    }
  }

  private _onStorageChanged = (): void => {
    this.setState({
      counter: 1 - this.state.counter
    });
  }

  private _onWorkbenchChanged = (): void => {
    if (this._ignoreStateChangeCounter > 0) {
      this._ignoreStateChangeCounter--;
    } else {
      const { workbench } = this.props;
      const newState = workbench.getState();
      if (this._currentPerspectiveNeedsSavingAfterChange(newState)) {
        this._updateCurrentPerspectiveWith(newState);
      }
    }
  }

  private _persistModificationsOfCurrentPerspective = async (): Promise<void> => {
    return this._updateCurrentPerspective(true);
  }

  private _revertModificationsOfCurrentPerspective = async (): Promise<void> => {
    const { storage, workbench } = this.props;
    const { selectedPerspectiveId } = this.state;

    if (storage !== undefined) {
      if (selectedPerspectiveId !== undefined && storage.isModified(selectedPerspectiveId)) {
        const { environment } = workbench;
        const confirmation = await environment.confirm(
          "Are you sure you want to revert the perspective to its last saved state?"
        );
        if (confirmation) {
          await storage.revertModifications(selectedPerspectiveId);
          await this._loadPerspectiveById(selectedPerspectiveId);
        }
      }
    } else {
      console.warn("No perspective storage while reverting perspective by ID; this is probably a bug.");
    }
  }

  /**
   * Requests the component to change the selected perspective ID. If the
   * component is uncontrolled, the change will happen immediately. If the
   * component is controlled, the change is propagated to the parent via the
   * `onChange()` handler, which has the opportunity to prevent the change
   * by returning `true`.
   *
   * @param id  the new perspective ID
   * @return true if the perspective ID is allowed to change, false otherwise
   */
  private _requestSelectedPerspectiveIdChange(id: string): boolean {
    if (!this.props.hasOwnProperty("selectedPerspectiveId")) {
      // Component is uncontrolled so we just change the state
      this.setState({
        selectedPerspectiveId: id
      });
      return true;
    } else {
      const { onChange } = this.props;
      if (onChange) {
        return !onChange(id);
      } else {
        return false;
      }
    }
  }

  private _setStorage(value: IPerspectiveStorage | undefined): void {
    if (this._storage === value) {
      return;
    }

    if (this._storage !== undefined) {
      this._storage.unsubscribe(this._onStorageChanged);
    }

    this._storage = value;
    this._forceReload();

    if (this._storage !== undefined) {
      this._storage.subscribe(this._onStorageChanged);
    }
  }

  private _setWorkbench(value: Workbench | undefined): void {
    if (this._workbench === value) {
      return;
    }

    if (this._workbench !== undefined) {
      this._workbench.off("stateChanged", this._onWorkbenchChanged);
    }

    this._workbench = value;

    if (this._workbench !== undefined) {
      this._workbench.on("stateChanged", this._onWorkbenchChanged);
    }
  }

  /**
   * Starts loading the list of perspectives if needed.
   */
  private _startLoadingIfNeeded = () => {
    const { storage } = this.props;
    const { perspectives, promise } = this.state;

    if (storage && promise === undefined && perspectives === undefined) {
      const loadingPromise = storage.map(
        (perspective: IPerspective, id: string): [string, IPerspective] => (
          [id, perspective]
        )
      ).then(newPerspectives => {
        this.setState({
          error: false,
          perspectives: newPerspectives,
          promise: undefined
        });
        return newPerspectives;
      }, (err: any) => {
        // Don't forget the previous set of perspectives if there was an
        // error -- it would be a bad UX
        this.setState({
          error: true,
          promise: undefined
        });
        throw err;
      });

      this.setState({
        promise: loadingPromise
      });
    }
  }

  private _updateCurrentPerspective = async (persist: boolean = false): Promise<void> => {
    const { workbench } = this.props;
    return this._updateCurrentPerspectiveWith(workbench.getState(), persist);
  }

  private _updateCurrentPerspectiveWith = async (
    newState: IWorkbenchState, persist: boolean = false
  ): Promise<void> => {
    const { storage } = this.props;
    const { selectedPerspectiveId } = this.state;

    if (storage === undefined) {
      console.warn("No perspective storage while saving perspective; this is probably a bug.");
    } else if (selectedPerspectiveId !== undefined) {
      await storage.update(selectedPerspectiveId, newState);
      this._lastState = newState;
      if (persist) {
        await storage.persistModifications(selectedPerspectiveId);
      }
    }
  }

}

/**
 * Props for the button that allows the user to load a perspective.
 */
export interface ILoadPerspectiveButtonProps {
  /**
   * Label of the button to show.
   */
  label?: React.ReactNode;

  /**
   * Whether the perspective was modified by the user compared to its last
   * stored base state in the perspective storage.
   */
  modified?: boolean;

  /**
   * Handler to call when the user clicks on the button in order to load the
   * perspective.
   */
  onClick?: (event: React.SyntheticEvent<any>) => void;

  /**
   * Whether the perspective is currently selected.
   */
  selected?: boolean;
}

const badgeOffset = [-3, -3];

/**
 * Stateless component that renders a button that can be clicked by the user
 * to load a perspective.
 */
const LoadPerspectiveButton = (props: ILoadPerspectiveButtonProps) => {
  const { label, modified, onClick, selected } = props;
  const classes = ["wb-perspective-bar-item"];
  if (selected) {
    classes.push("wb-perspective-selected");
  }
  if (modified) {
    classes.push("wb-perspective-modified");
  }
  return (
    <div className={classes.join(" ")}>
      <button className="wb-perspective-bar-load-button" onClick={onClick}>{label}</button>
      <Badge className="wb-badge" visible={modified} offset={badgeOffset} />
    </div>
  );
};

/**
 * Props for the button that allows the user to create a new perspective.
 */
export interface INewPerspectiveButtonProps {
  /**
   * Handler to call when the user clicks on the button in order to save the
   * current configuration as a new perspective.
   */
  onClick?: (event: React.SyntheticEvent<any>) => void;
}

/**
 * Stateless component that renders a button that can be clicked by the user
 * to load a perspective.
 */
const NewPerspectiveButton = ({ onClick }: INewPerspectiveButtonProps) => {
  return (
    <div className="wb-perspective-bar-item">
      <button className="wb-perspective-bar-new-button"
              onClick={onClick}>+ New</button>
    </div>
  );
};

/**
 * Props for the button that allows the user to reload the list of perspectives
 * in case of an error.
 */
export interface IReloadPerspectivesButtonProps {
  /**
   * Label to use on the button.
   */
  label?: string;
  /**
   * Handler to call when the user clicks on the button in order to reload the
   * list of perspectives.
   */
  onClick?: (event: React.SyntheticEvent<any>) => void;
}

/**
 * Stateless component that renders a button that can be clicked by the user
 * to reload the list of perspectives.
 */
const ReloadPerspectivesButton = ({ label, onClick }: IReloadPerspectivesButtonProps) => {
  return (
    <div className="wb-perspective-bar-item">
      <button className="wb-perspective-bar-reload-button"
              onClick={onClick}>
        {label !== undefined ? label : "Error while loading \u2014 click to reload"}
      </button>
    </div>
  );
};

/**
 * Props for the button that allows the user to save a perspective.
 */
export interface ISavePerspectiveButtonProps {
  /**
   * Whether the button is enabled.
   */
  disabled?: boolean;

  /**
   * Handler to call when the user clicks on the button in order to save the
   * current configuration as a perspective.
   */
  onClick?: (event: React.SyntheticEvent<any>) => void;
}

/**
 * Stateless component that renders a button that can be clicked by the user
 * to load a perspective.
 */
const SavePerspectiveButton = ({ disabled, onClick }: ISavePerspectiveButtonProps) => {
  return (
    <div className="wb-perspective-bar-item">
      <button className="wb-perspective-bar-save-button"
              disabled={disabled} onClick={onClick}>Save</button>
    </div>
  );
};
